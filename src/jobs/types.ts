import type {Issue,PreparedInput} from '@flowdoc/core';
export interface Job {id:string;versionId:string;preparedInput:PreparedInput}
export interface JobReceipt {jobId:string;version:number;status:'queued'|'running'|'succeeded'|'failed';hasWarnings:boolean;warnings:Issue[];skippedContentIndices:number[]}
export interface JobView {jobId:string;version:number;status:'queued'|'running'|'succeeded'|'failed';hasWarnings:boolean;warnings:Issue[];skippedContentIndices:number[];errors:Issue[]}
