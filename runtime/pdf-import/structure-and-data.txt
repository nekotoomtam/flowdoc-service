# Model20 definitions, occurrences and data

## Authority Boundary

Owner: FlowDoc Project Control. This guide is for the private model20 candidate
only: Core0.6.0 / Service0.6.0 / schema029 and its exact reviewed archive.
It does not describe the currently installed package or authorize publication,
installation, real-data access or a release. Core owns validation/rendering and
Service owns persistence/admission. Runtime discovery and verified output take
precedence over prose. The old prepared18/19 guide sources remain historical
inputs; they are not shipped as model20 examples in this candidate.

## 1. Template root

Use schemaVersion1 or2, nodeModelVersion20, server-created templateId/docKey,
version1 for drafts, name, book, pageLayouts, styles, globalSchema, sections and
examples (normally []). book selects contentSlot:"body" and defaultPageLayoutId.
areaFormats is optional unless Areas require definitions. An explicitly empty
map remains distinct from absence in fingerprints. defaultFileName is optional
attachment metadata without an extension; fileName is a /documents override.
There are no global header/footer, top-level formats or Section.formats maps.

## 2. Reusable Section definitions

Each Section has a unique UUID id, unique sectionKey, label, nameBase,
inputSchema and source. sectionKey starts with an ASCII letter and then at most
63 letters/digits/_/-. source is authored (fragment/repeats and optional
cellRepeats/rowGroups) or blank. Optional pageLayoutId, header/footer, modes and
numbering retain their normal layout meaning. role:"cover" is allowed only as
the first actual occurrence and cannot repeat; definition-array position alone
does not make a cover valid. Do not invent or copy server-owned origin metadata.

## 3. Request order and instance identity

```json
{"docKey":"example","data":{},"sections":[
 {"sectionKey":"A","instanceKey":"first","data":{}},
 {"sectionKey":"B","instanceKey":"middle","data":{}},
 {"sectionKey":"A","instanceKey":"last","data":{}}
]}
```

This shape requires actual A/B definitions and their declared fields. instanceKey
uses the same ASCII key grammar, is mandatory and unique per request. Body data,
header/footer data and Section assets belong to that occurrence. Header/footer
values are direct objects, not nested under another data property. Request order
is preserved; it is not resorted into definition order. Definition id is not an
input selector. Diagnostic/source Section identity uses instance-<instanceKey>.
Never send prepared input, sourceMap, a legacy map or id-only occurrences.

## 4. Fragment, Area and Format

A fragment has ordered rootIds and nodes keyed by node.id. Parent order is
rowIds→cellIds→childIds for tables, and inline children for TextBlock. Nodes
must have one owner, no cycle, no dangling IDs; '~' is reserved for composition.
Declare an Area field with type:"area" and unique areaId; place an area node
at its desired position. A Format in areaFormats has key, ownerAreaId,
inputSchema, fragment and repeats. Request entries use Format.key, not the map
key: [{"format":"chapter","data":{...}}]. Formats belong to explicit Area
variables. Scope remains global/section/local/item/group as declared; a Format
reads section data from its owning occurrence. Band scopes are header/footer.

## 5. Schemas and strict data

ObjectSchema is {type:"object",fields:{...}}. String, image, link, array and
Area fields retain their declared schemas; arrays contain object items and may
nest only within existing bounds. Required presence is checked before defaults.
Numbers/null/booleans are not coerced to text. Preserve Unicode, newline and tab
according to validation. An unknown field is an error, not UNKNOWN_VARIABLE
warning/ignored data. Unknown sectionKey is SECTION_KEY_UNKNOWN; duplicate
instanceKey is SECTION_INSTANCE_DUPLICATE. Do not drop data to make it pass.

System page fields are rendered values, not caller current/total variables.
TOC needs explicit scope:{kind:"section"} or {kind:"document"}; Section scope
means the current occurrence. Local anchors may repeat in different occurrences
but not within one. No targetSectionId from older models is accepted.
Examples inside a definition must pin matching request.version. Preview may add
uploadId; remove transport fields from a Core sample used for validate_template.
