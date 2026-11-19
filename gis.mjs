// Original static GIS adapter. Official observations only, never legal determinations.
const ROOT='https://services1.arcgis.com/vQBE9cyhukJHVTrT/arcgis/rest/services/';
export const LAYERS=Object.freeze({addresses:'address_vwPublic/FeatureServer/0',parcels:'Parcel_vwPublic/FeatureServer/0',planning:'PlanningParcels_vw/FeatureServer/0',jurisdiction:'CityLimit_vwPublic/FeatureServer/4',base:'Zoning_vwPublic/FeatureServer/0',downtown_revitalization:'DowntownRevitalizationDistrict_vwPublic/FeatureServer/0',downtown_specific_plan:'PleasantonDowntownSpecificPlanLandUse_vwPublic/FeatureServer/0',ordinance_polygons:'OrdinanceCode_vwPublic/FeatureServer/0',ordinance_annotation_points:'Zoning_Ordinance_Code_Ptv01_vwPublic/FeatureServer/0'});
export const now=()=>new Date().toISOString();
export function normalizeAddress(value){const a=String(value).normalize('NFKC').trim().toUpperCase().replace(/\s+/g,' ');if(!/^[A-Z0-9 #./'\-]{3,160}$/.test(a))throw Error('地址格式无效：请使用街道地址，不接受通配符/控制字符。');return a;}
export function polygon(g){if(!g||!Array.isArray(g.rings)||!g.rings.length||g.rings.length>100||['xmin','xmax','x','y','curveRings'].some(k=>k in g)||(g.spatialReference?.wkid??4326)!==4326)throw Error('需要官方WGS84真实polygon；点/包络/曲线不可替代。');let n=0;for(const ring of g.rings){if(!Array.isArray(ring)||ring.length<4||JSON.stringify(ring[0])!==JSON.stringify(ring.at(-1)))throw Error('polygon环未闭合。');let area=0;for(let i=0;i<ring.length;i++){const p=ring[i];if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('polygon坐标无效。');if(i)area+=ring[i-1][0]*p[1]-p[0]*ring[i-1][1];}if(Math.abs(area)<1e-15)throw Error('polygon退化。');n+=ring.length;}if(n>5000)throw Error('polygon超过复杂度上限；不简化或改用bbox。');return {rings:g.rings,spatialReference:{wkid:4326}};}
export class OfficialGIS{
 constructor(fetcher=globalThis.fetch,{signal}={}){this.fetcher=fetcher.bind(globalThis);this.signal=signal;this.count=0;this.started=Date.now();}
 async query(layer,where='1=1',geometry=null,geometryType='esriGeometryPolygon',returnGeometry=true){
  if(!Object.hasOwn(LAYERS,layer))throw Error('未知官方层，拒绝任意URL。');
  const url=ROOT+LAYERS[layer]+'/query',at=now();const params={f:'json',where,outFields:layer==='addresses'?'OBJECTID,FullAddress,APN,CitySitusFull,ZipCode,Status':'*',returnGeometry:String(returnGeometry),outSR:'4326',resultRecordCount:'100',orderByFields:'OBJECTID'};
  if(geometry)Object.assign(params,{geometry:JSON.stringify(geometry),geometryType,inSR:'4326',spatialRel:'esriSpatialRelIntersects'});
  const source={url,queriedAt:at,query_mode:'browser_live_official',legalEffectiveDate:null};let timer,local;
  try{
   if(this.signal?.aborted)throw Error('操作已取消。');if(++this.count>32||Date.now()-this.started>90000)throw Error('超出单次操作请求/时间预算。');
   const encoded=new URLSearchParams(params);if(encoded.toString().length>250000)throw Error('查询几何超限；不简化或改用bbox。');
   local=new AbortController();const cancel=()=>local.abort();this.signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,12000);
   let response,raw;
   try{
    response=await this.fetcher(url,{method:'POST',body:encoded,headers:{Accept:'application/json'},mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:local.signal});
    source.httpStatus=response.status;if(!response.ok)throw Error('官方HTTP '+response.status);if(Number(response.headers.get('content-length')||0)>2000000)throw Error('官方响应超过2MB。');
    if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2000000){await reader.cancel();throw Error('官方响应超过2MB。');}chunks.push(part.value);}}finally{reader.releaseLock();}const all=new Uint8Array(bytes);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.byteLength;}raw=new TextDecoder('utf-8',{fatal:true}).decode(all);}else{const bytes=await response.arrayBuffer();if(bytes.byteLength>2000000)throw Error('官方响应超过2MB。');raw=new TextDecoder().decode(bytes);}
   }finally{clearTimeout(timer);this.signal?.removeEventListener('abort',cancel);}
   if(this.signal?.aborted)throw Error('操作已取消。');const payload=JSON.parse(raw);
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.error)throw Error('官方JSON error/无效响应：'+String(payload?.error?.message||'query failed'));
   const features=payload.features;if(!Array.isArray(features)||features.some(f=>!f||!f.attributes||typeof f.attributes!=='object'||Array.isArray(f.attributes)))throw Error('官方features结构无效。');
   if('exceededTransferLimit' in payload&&typeof payload.exceededTransferLimit!=='boolean')throw Error('官方截断标志无效。');
   const sr=payload.spatialReference?.latestWkid??payload.spatialReference?.wkid;
   if(returnGeometry&&features.length&&(sr!==4326&&!(sr===undefined&&features.every(f=>f.geometry?.spatialReference?.wkid===4326))))throw Error('官方geometry坐标系未确认WGS84。');
   const truncated=payload.exceededTransferLimit===true||features.length>=100;
   return {status:truncated?'incomplete':features.length?'complete':'empty',usable:!truncated,truncated,returnedFeatureCount:features.length,totalFeatureCount:truncated?null:features.length,features,source,query:params,notice:'无返回不是无约束；相交包括可能的边界接触。'};
  }catch(error){clearTimeout(timer);return {status:'error',usable:false,features:[],returnedFeatureCount:null,totalFeatureCount:null,source,query:params,error:String(error.message||error),notice:'网络/CORS/服务/预算失败，未判定；不回放或静默给默认值。'};}
 }
 async resolve(address){const normalizedInput=normalizeAddress(address),where=normalizedInput.split(' ').map(t=>"UPPER(FullAddress) LIKE '%"+t.replaceAll("'","''")+"%'").join(' AND '),q=await this.query('addresses',where);return {query_mode:'browser_live_official',status:q.status,source:q.source,query:q.query,error:q.error,truncated:q.truncated??false,normalizedInput,match_count:q.features.length,match_count_kind:'returned_only',total_match_count:['complete','empty'].includes(q.status)?q.features.length:null,selection_allowed:q.status==='complete',autoSelected:false,candidates:q.features.map(f=>({address:f.attributes.FullAddress,apn:f.attributes.APN,city:f.attributes.CitySitusFull,attributes:f.attributes,addressPoint:f.geometry?{...f.geometry,spatialReference:{wkid:4326}}:null}))};}
 async parcel(candidate){
  if(String(candidate?.city||'').trim().toLowerCase()!=='pleasanton'||!/^[-0-9 ]{3,30}$/.test(candidate?.apn||''))throw Error('候选城市/APN未确认；禁止另一城市默认值。');
  const literal=candidate.apn.replaceAll("'","''"),parcel=await this.query('parcels',"APN='"+literal+"'");
  const result={query_mode:'browser_live_official',queriedAt:now(),selectedAddress:candidate,apn:candidate.apn,status:'undetermined',geometry_kind:'undetermined',parcel,parcels:[],jurisdiction:null,baseZoning:null,overlays:{},unknownCoverage:['Enterprise Downtown Core/Hospitality独立层未接入','Hillside属性不是独立overlay几何','法规/地图许可SLA和全量overlay覆盖未核验'],limits:['官方空间相交观察，不是法律分区/合规/CEQA结论','不计算面积覆盖率或完全包含；边界接触也可能相交','条例0要素只是无返回，注记点不是条例覆盖范围','无地图渲染/图纸审查/法规自动更新；不能保证审批，不构成法律意见'],legalEffectiveDate:null};
  if(parcel.status!=='complete')return result;if(parcel.features.length>4){result.status='incomplete';result.limits.push('超过4个地块面，不静默缩减。');return result;}
  try{result.parcels=parcel.features.map(f=>({attributes:f.attributes,geometry:polygon(f.geometry),vertexCount:f.geometry.rings.reduce((s,r)=>s+r.length,0)}));}catch(error){result.geometryError=error.message;return result;}
  result.geometry_kind='polygon';
  for(const layer of ['jurisdiction','base','downtown_revitalization','downtown_specific_plan','ordinance_polygons','ordinance_annotation_points']){
   const parts=[];for(const p of result.parcels)parts.push(await this.query(layer,'1=1',p.geometry,'esriGeometryPolygon',layer==='base'));
   const status=parts.some(p=>p.status==='error')?'error':parts.some(p=>p.status==='incomplete')?'incomplete':parts.every(p=>p.status==='empty')?'empty':'complete';
   const features=[],seen=new Set();for(const p of parts)for(const f of p.features){const id=f.attributes.OBJECTID;if(id!==undefined&&seen.has(String(id)))continue;if(id!==undefined)seen.add(String(id));features.push(f);}
   const all={status,usable:['complete','empty'].includes(status),parts,features,returnedFeatureCount:features.length,totalFeatureCount:['complete','empty'].includes(status)?features.length:null,sourceURL:ROOT+LAYERS[layer]+'/query'};
   if(layer==='jurisdiction')result.jurisdiction=all;else if(layer==='base')result.baseZoning=all;else result.overlays[layer]=all;
  }
  const base=result.baseZoning;const invalid=base.features.some(f=>typeof f.attributes.DATA!=='string'||!f.attributes.DATA.trim());if(invalid){base.status='incomplete';base.usable=false;}base.observedCodes=[...new Set(base.features.map(f=>f.attributes.DATA).filter(v=>typeof v==='string'&&v.trim()))].sort();base.codes=base.usable?base.observedCodes:[];
  const j=result.jurisdiction,cities=[...new Set(j.features.map(f=>String(f.attributes.cityname||'').trim().toLowerCase()))];j.interpretation=j.usable&&cities.length===1&&cities[0]==='pleasanton'?'intersects_pleasanton_only_containment_unverified':'undetermined_or_multiple_jurisdictions';
  result.status=j.status==='complete'&&base.status==='complete'&&base.codes.length&&j.interpretation.startsWith('intersects_')?'limited_observations':'undetermined';
  const point=candidate.addressPoint;if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y))result.pointComparison={notParcelDetermination:true,geometry_mode:'address_point_comparison_only',...await this.query('base','1=1',{x:point.x,y:point.y,spatialReference:{wkid:4326}},'esriGeometryPoint',false)};else result.pointComparison={status:'unknown'};
  result.planning=await this.query('planning',"APN='"+literal+"'",null,'esriGeometryPolygon',false);return result;
 }
}
