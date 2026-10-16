export const FONT_LIMITS=Object.freeze({fileBytes:10*1024*1024,licenseBytes:1024*1024,setBytes:128*1024*1024,files:64,licenses:16,metadataBytes:1024*1024,sessionMs:86400000,parseMs:30000});
export interface FontMetadata {
 rawWeight:number;style:'normal'|'italic';fileVersion:string;
 names:{family:string;subfamily:string;fullName:string;postScriptName:string;license:string;licenseUrl:string};
 coverage:number[];coverageDigest:string;sha256:string;byteLength:number;
}
export interface FileDeclaration {clientKey:string;byteLength:number;sha256:string}
export interface SourceEvidence {
 clientKey:string;provider:'google-fonts';locator:string;retrievedAt:string;metadataHash:string;fileHashBinding:string;
 sourceWeight:number|null;licenseClientKeys:string[];
}
export interface ImportInput {requestId:string;reason:string;files:FileDeclaration[];licenseFiles:FileDeclaration[];sourceEvidence:SourceEvidence[]}
export interface Mutation {requestId:string;reason:string;expectedRevision:number}
export interface FaceBinding {assetId:string;sourceEvidenceId:string;sourceWeight:number|null;approvedWeight:number|null;style:'normal'|'italic';conflictResolution?:{reason:string;sourceWeight:number|null;approvedWeight:number}}
export interface ReleaseInput {requestId:string;reason:string;familyId:string;version:number;importId:string;languageScope:('th'|'en')[];faceBindings:FaceBinding[]}
export interface FamilyInput {requestId:string;reason:string;displayName:string;internalNames:string[];sourceIdentity:{provider:'google-fonts';providerFamilyKey:string}}
