import {taskError} from './quota.js';
export type OutputFormat = 'pdf' | 'docx';

/** Header values, including their multiplicity, are transport metadata. */
export function parseOutputFormat(value: unknown): OutputFormat {
    if (value === undefined) return 'pdf';
    if (Array.isArray(value)) {
        if (value.length === 0) return 'pdf';
        if (value.length !== 1) throw taskError('INVALID_REQUEST');
        value = value[0];
    }
    if (typeof value !== 'string') throw taskError('INVALID_REQUEST');
    const format = value.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase();
    if (format !== 'pdf' && format !== 'docx') throw taskError('INVALID_REQUEST');
    return format;
}

/** V1 is immutable historical PDF; V2 binds format into the hashed envelope. */
export function verifyEnvelopeFormat(version: unknown, format: unknown, expectedVersion: unknown, expectedFormat: unknown): OutputFormat {
    if (version !== expectedVersion || !['pdf', 'docx'].includes(expectedFormat as string)) throw taskError('INPUT_INTEGRITY');
    if (version === 1 && format === undefined && expectedFormat === 'pdf') return 'pdf';
    if (version === 2 && format === expectedFormat) return format as OutputFormat;
    throw taskError('INPUT_INTEGRITY');
}
