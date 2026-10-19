import { composeTaskDocument, validateTemplate, createPdfEngine, PDF_STREAM_CONTRACT } from '@flowdoc/core';
import type { TaskValue, StreamPdfImage, PdfStreamRef } from '@flowdoc/core';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { openTaskJson } from './json-reader.js';
import { imageNodes } from '../images/nodes.js';
import { snapshotResources } from '../fonts/snapshot.js';
const zip = promisify(deflate), abort = new AbortController();
let sequence = 0, finished = false;
const pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: unknown) => void;
}>();
const error = (code: string) => Object.assign(Error(code), { code });
function rpc(op: string, body: Record<string, unknown> = {}): Promise<any> {
    abort.signal.throwIfAborted();
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send!({ id, op, ...body }); });
}
process.on('message', (m: any) => {
    if (m?.type === 'abort') {
        abort.abort(error(m.code));
        for (const p of pending.values())
            p.reject(abort.signal.reason);
        pending.clear();
        return;
    }
    if (m?.ack) {
        const p = pending.get(m.ack);
        pending.delete(m.ack);
        if (m.error)
            p?.reject(error(m.error));
        else
            p?.resolve(m.value);
    }
});
process.on('disconnect', () => {
    if (finished)
        return;
    try {
        process.kill(-process.pid, 'SIGKILL');
    }
    catch {
        process.exit(1);
    }
});
async function digest(path: string) {
    const h = createHash('sha256');
    for await (const b of createReadStream(path, { highWaterMark: 65536, signal: abort.signal }))
        h.update(b);
    return h.digest('hex');
}
async function decode(v: TaskValue, max: number): Promise<any> {
    if (await v.byteLength() > max)
        throw error('LIMIT_EXCEEDED');
    const k = await v.kind();
    if (k === 'scalar')
        return v.scalar();
    if (k === 'array') {
        const a = [];
        for await (const x of v.elements())
            a.push(await decode(x, max));
        return a;
    }
    const o = Object.create(null);
    for await (const [k, x] of v.properties())
        o[k] = await decode(x, max);
    return o;
}
async function store(bytes: Uint8Array, kind: 'prepared' | 'output', key?: string) {
    const created = key ? { key } : await rpc('open', { kind });
    for (let at = 0; at < bytes.length; at += 65536)
        await rpc('write', { key: created.key, chunk: Buffer.from(bytes.subarray(at, at + 65536)) });
    return created.key as string;
}
async function prepared(bytes: Uint8Array) { const key = await store(bytes, 'prepared'); return await rpc('seal', { key }) as PdfStreamRef; }
const pt = (l: any) => l.unit === 'mm' ? l.value * 72 / 25.4 : l.value;
async function prepare(source: any, node: any, input: any): Promise<StreamPdfImage> {
    await rpc('decode');
    const f = input.sources.find((f: any) => f.id === source.sourceFileId);
    if (!f || f.checksum !== source.sha256 || await digest(f.path) !== source.sha256)
        throw error('INPUT_INTEGRITY');
    const width = Math.max(1, Math.round(pt(node.props.width) * 200 / 72)), height = Math.max(1, Math.round(pt(node.props.height) * 200 / 72));
    if (width * height > 8000000)
        throw error('IMAGE_UNUSABLE');
    const pipeline = sharp(f.path, { limitInputPixels: 40000000, failOn: 'warning' }).timeout({ seconds: Math.max(1, Math.ceil(input.policy.imageMs / 1000)) }).rotate().toColourspace('srgb').resize({ width, height, fit: 'inside', withoutEnlargement: true });
    if (source.mediaType === 'image/jpeg') {
        const { data, info } = await pipeline.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
        if (data.length > input.policy.imageBytes)
            throw error('IMAGE_UNUSABLE');
        return { kind: 'jpeg', width: info.width, height: info.height, content: await prepared(data) };
    }
    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = info.width * info.height;
    if (info.channels !== 4 || pixels > 8000000)
        throw error('IMAGE_UNUSABLE');
    const rgb = Buffer.allocUnsafe(pixels * 3), alpha = Buffer.allocUnsafe(pixels);
    for (let i = 0; i < pixels; i++) {
        rgb[i * 3] = data[i * 4]!;
        rgb[i * 3 + 1] = data[i * 4 + 1]!;
        rgb[i * 3 + 2] = data[i * 4 + 2]!;
        alpha[i] = data[i * 4 + 3]!;
    }
    return { kind: 'rgb-deflate', width: info.width, height: info.height, content: await prepared(await zip(rgb, { level: 6 })), alpha: await prepared(await zip(alpha, { level: 6 })) };
}
async function run(input: any) {
    sharp.cache(false);
    sharp.concurrency(1);
    if (await digest(input.path) !== input.digest)
        throw error('INPUT_INTEGRITY');
    const reader = await openTaskJson(input.path, abort.signal);
    let task: TaskValue | undefined, resources: any[] = [];
    try {
        for await (const [key, value] of reader.value.properties()) {
            if (key === 'input')
                task = value;
            else if (key === 'resources')
                resources = await decode(value, 8 * 1048576);
            else if (key === 'core') {
                const pin = await decode(value, 1024);
                if (pin.version !== input.core.version || pin.sha256 !== input.core.sha256)
                    throw error('RENDERER_PIN_MISMATCH');
            }
        }
        const template = validateTemplate(input.template);
        if (!template.ok || template.value.fingerprint !== input.templateFingerprint || !task)
            throw error('INVALID_DATA');
        const composed = await composeTaskDocument(template.value, task, { signal: abort.signal });
        if (!composed.ok)
            throw error(composed.issues[0]?.code ?? 'INVALID_DATA');
        const document = composed.value, images: Record<string, StreamPdfImage> = {}, omitted = new Set<string>();
        const nodes = imageNodes(document);
        if (nodes.length > 10000)
            throw error('LIMIT_EXCEEDED');
        const owners = new Map<string, string>();
        for (const section of document.sections ?? [])
            for (const band of [section.header, section.footer])
                for (const id of Object.keys(band?.nodes ?? {}))
                    owners.set(id, section.sectionId);
        const variants = new Map<string, {
            id: string;
            source: any;
            nodes: typeof nodes;
        }>();
        let normalizedOmitted = 0, preparationOmitted = 0, findingCount = 0, diagnosticBytes = 0;
        for (const node of nodes) {
            const old = node.props.resourceId;
            if (old.startsWith('unavailable-')) {
                omitted.add(node.id);
                normalizedOmitted++;
                continue;
            }
            const source = resources.find(r => r.assetId === old);
            if (!source)
                throw error('INPUT_INTEGRITY');
            const signature = JSON.stringify([old, node.props.width, node.props.height, 200, 'srgb-orientation-v1']);
            let variant = variants.get(signature);
            if (!variant) {
                if (variants.size >= input.policy.maxDerivatives)
                    throw error('LIMIT_EXCEEDED');
                variant = { id: randomUUID(), source, nodes: [] };
                variants.set(signature, variant);
            }
            variant.nodes.push(node);
            node.props.resourceId = variant.id;
        }
        for (const variant of variants.values()) {
            const first = variant.nodes[0]!;
            try {
                images[variant.id] = await prepare(variant.source, first, input);
            }
            catch (e) {
                const code = (e as any)?.code;
                if (abort.signal.aborted || code && !['IMAGE_UNUSABLE'].includes(code))
                    throw e;
                const source = input.sources.find((f: any) => f.id === variant.source.sourceFileId);
                if (!source?.logical_path?.endsWith('/image'))
                    throw error('INPUT_INTEGRITY');
                const bySection = new Map<string | null, typeof nodes>();
                for (const node of variant.nodes) {
                    const section = document.sourceMap[node.id]?.sectionId ?? owners.get(node.id) ?? variant.source.sectionId ?? null;
                    const group = bySection.get(section) ?? [];
                    group.push(node);
                    bySection.set(section, group);
                }
                for (const [sectionId, affected] of bySection) {
                    const sample: string[] = [];
                    let sampleBytes = 0;
                    for (const node of affected) {
                        if (sample.length >= 16 || sampleBytes + Buffer.byteLength(node.id) > 8192)
                            break;
                        sample.push(node.id);
                        sampleBytes += Buffer.byteLength(node.id);
                    }
                    const detail = { stage: 'preparation', assetId: variant.source.assetId, variant: { widthPt: pt(first.props.width), heightPt: pt(first.props.height), frame: { width: first.props.width, height: first.props.height }, dpi: 200, transformVersion: 'srgb-orientation-v1' }, nodeIdsSample: sample, sampleTruncated: sample.length < affected.length };
                    const finding = { code: 'IMAGE_UNUSABLE', sectionId, pointer: source.logical_path.slice(0, -6), affectedPlacementCount: affected.length, detail };
                    diagnosticBytes += Buffer.byteLength(JSON.stringify(finding));
                    if (diagnosticBytes > input.policy.maxIndexBytes)
                        throw error('LIMIT_EXCEEDED');
                    await rpc('finding', finding); // Suppress engine duplicates only after equivalent durable diagnostics are committed.
                    findingCount++;
                    preparationOmitted += affected.length;
                    for (const node of affected)
                        omitted.add(node.id);
                }
            }
        }
        const fonts = await snapshotResources(input.fontSnapshot, input.workspace, input.fontRoot);
        const engine = await createPdfEngine(fonts);
        if (!engine.ok)
            throw error(engine.issues[0]?.code ?? 'FONT_CHECK_UNAVAILABLE');
        let output: string | undefined;
        const result = await engine.value.generatePdfTo(document, { contract: PDF_STREAM_CONTRACT, images, async *open(ref, signal) {
                const path = await rpc('path', { key: ref.key });
                for await (const b of createReadStream(path, { highWaterMark: 65536, ...(signal ? { signal } : {}) }))
                    yield b;
            } }, { async write(b) {
                if (!output) {
                    await rpc('workspaceSealed');
                    output = await store(new Uint8Array(), 'output');
                }
                await store(b, 'output', output);
            }, async abort() { } }, { signal: abort.signal, maxBytes: input.policy.pdfBytes });
        if (!result.ok)
            throw error(result.issues[0]?.code ?? 'RENDER_FAILED');
        if (!output)
            throw error('RENDER_FAILED');
        const ref = await rpc('seal', { key: output });
        if (ref.byteLength !== result.value.byteLength || ref.sha256 !== result.value.sha256)
            throw error('STORAGE_IO');
        const warnings = result.warnings.filter(w => !(w.code === 'IMAGE_UNAVAILABLE' && omitted.has(w.nodeId ?? '')));
        if (warnings.length > 10000)
            throw error('LIMIT_EXCEEDED');
        const summary = { version: 1, scope: 'expanded-image-nodes', imagePlacementCount: nodes.length, normalizedOmittedPlacementCount: normalizedOmitted, preparationOmittedPlacementCount: preparationOmitted, omittedPlacementCount: normalizedOmitted + preparationOmitted, findingCount, formatOmissionCount: warnings.filter(w=>w.code==='FORMAT_CONTENT_OMITTED').length, completeness: omitted.size || warnings.some(w => w.code === 'FORMAT_CONTENT_OMITTED') ? 'partial' : 'complete' };
        await rpc('complete', { output, receipt: result.value, warningCount: warnings.length, warnings: warnings.slice(0, 100), summary });
    }
    finally {
        await reader.close();
    }
}
process.once('message', (m: any) => {
    if (m?.type !== 'init')
        process.exit(1);
    void run(m.input).then(() => { finished = true; process.exitCode = 0; process.disconnect?.(); }, async (e) => {
        try {
            await rpc('failed', { code: /^[A-Z_]+$/.test(e?.code) ? e.code : 'RENDER_FAILED' });
        }
        catch { }
        finished = true;
        process.exitCode = 1;
        process.disconnect?.();
    });
});
