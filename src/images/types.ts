export interface ImageWarning {code:'IMAGE_LOW_RESOLUTION'|'IMAGE_UNUSABLE'|'IMAGE_TIMEOUT';message:string}
export interface PreparedImage {path:string;width:number;height:number;mediaType:'image/jpeg'|'image/png';byteSize:number;effectiveDpi:number}
export type ImagePreparationResult={status:'prepared';image:PreparedImage;warnings:ImageWarning[]}|{status:'skipped';warnings:ImageWarning[]};
export interface ImagePreparationInput {
 /** Trusted paths resolved by Service, never accepted directly from HTTP. */
 sourcePath:string;outputDirectory:string;widthPt:number;heightPt:number;
 dpi?:number;timeoutMs?:number;signal?:AbortSignal;
}
