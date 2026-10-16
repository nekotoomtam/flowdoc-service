import {it,expect} from 'vitest';
import * as core from '@flowdoc/core';
const metric=(topDesign,unitsPerEm=1000)=>({methodId:'thai-bo-baseline-top-v1',unitsPerEm,topDesign});
it('consumes the new root API from the installed packed Core, preserving the contract',()=>{
 expect(core.calculateFontHeightAdjustment).toBeTypeOf('function');
 expect(core.FONT_HEIGHT_METHOD).toBe('thai-bo-baseline-top-v1');
 const result=core.calculateFontHeightAdjustment({fontSizePt:16,sourceMetric:metric('400'),targetMetric:metric('586')});
 expect(result).toEqual({ok:true,value:{fontSizePt:10.921502,methodId:core.FONT_HEIGHT_METHOD}});
 for(const input of [
  {fontSizePt:16,sourceMetric:metric('400'),targetMetric:null},
  {fontSizePt:16,sourceMetric:metric('400'),targetMetric:{outcome:'unavailable',topDesign:null}},
 ])expect(core.calculateFontHeightAdjustment(input)).toEqual({ok:false,code:'METRIC_INVALID'});
 expect(core.calculateFontHeightAdjustment({fontSizePt:1,sourceMetric:metric('1.0000005'),targetMetric:metric('1')})).toMatchObject({ok:true,value:{fontSizePt:1.000001}});
 expect(core.calculateFontHeightAdjustment({fontSizePt:1e-20,sourceMetric:metric('1'),targetMetric:metric('2')})).toEqual({ok:false,code:'NUMERIC_RANGE'});
 expect(core.calculateFontHeightAdjustment({fontSizePt:16,sourceMetric:metric('400'),targetMetric:{...metric('400'),methodId:'future-v2'}})).toEqual({ok:false,code:'METHOD_UNSUPPORTED'});
});
