/* Standalone prize-stock rules; usable by the browser and node:test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.CapsuleInventory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_ROWS = 16;
  const MAX_STOCK = 99999;
  function makeId() {
    return 'p-' + (Date.now().toString(36)) + '-' + (Math.random().toString(36).slice(2, 10));
  }
  function normalizedEntry(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') throw new Error('상품 데이터가 잘못되었습니다.');
    const name = String(raw.name || '').trim();
    if (!name || Array.from(name).length > 48) throw new Error('상품 이름은 1~48글자로 입력해 주세요.');
    const limit = raw.limit === '' || raw.limit === null || raw.limit === undefined ? null : Number(raw.limit);
    const issued = raw.issued === '' || raw.issued === undefined || raw.issued === null ? 0 : Number(raw.issued);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_STOCK)) throw new Error('총 수량은 0~99,999 사이의 정수로 입력하거나 무제한으로 비워 주세요.');
    if (!Number.isInteger(issued) || issued < 0 || issued > MAX_STOCK) throw new Error('지급량은 0~99,999 사이의 정수만 가능합니다.');
    const grade = raw.grade === undefined || raw.grade === null || raw.grade === '' ? 1 : Number(raw.grade);
    if(!Number.isInteger(grade)||grade<1||grade>4)throw new Error('등급은 1~4 중에서 선택하세요.');
    return {grade, id: typeof raw.id === 'string' && /^p-[a-z0-9-]+$/i.test(raw.id) ? raw.id : (fallbackId || makeId()), name, limit, issued};
  }
  function normalizeInventory(rows) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('상품은 1~16종으로 설정해 주세요.');
    const ids = new Set();
    return rows.map((row) => {
      const result = normalizedEntry(row);
      if (ids.has(result.id)) result.id = makeId();
      ids.add(result.id);
      return result;
    });
  }
  function parseRewardText(raw) {
    const lines=String(raw).replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
    if(!lines.length)return [];
    if(lines.length>MAX_ROWS)throw new Error('보상은 최대 '+MAX_ROWS+'종까지 입력할 수 있습니다.');
    return normalizeInventory(lines.map((line,index)=>{
      const columns=line.split('|').map(x=>x.trim());
      if(columns.length!==3)throw new Error((index+1)+'번째 줄은 등급|상품명|수량 형식이어야 합니다.');
      if(!/^[1-4]$/.test(columns[0]))throw new Error((index+1)+'번째 줄 등급은 1~4입니다.');
      if(columns[2]&&!/^(?:0|[1-9]\d*)$/.test(columns[2]))throw new Error((index+1)+'번째 줄 수량이 잘못되었습니다.');
      return {grade:Number(columns[0]),name:columns[1],limit:columns[2]===''?null:Number(columns[2]),issued:0};
    }));
  }
  function toRewardText(rows){return rows.map(p=>`${p.grade||1}|${p.name}|${p.limit===null?'':p.limit}`).join('\n')+'\n';}
  function fromNames(names) {
    return normalizeInventory(names.map(name => ({name, limit:null, issued:0})));
  }
  function available(rows) { return rows.filter(item => item.limit === null || item.issued < item.limit); }
  function award(rows, id) {
    const row = rows.find(item => item.id === id);
    if (!row || !available([row]).length) return false;
    row.issued += 1;
    return true;
  }
  function counts(rows) {
    const active = available(rows);
    return {total:rows.length, active:active.length, exhausted:rows.length-active.length,
      issued:rows.reduce((sum,item)=>sum+item.issued,0),
      finiteLeft:rows.reduce((sum,item)=>sum+(item.limit === null ? 0 : Math.max(0,item.limit-item.issued)),0)};
  }
  return {MAX_ROWS, MAX_STOCK, normalizeInventory, normalizedEntry, fromNames, parseRewardText, toRewardText, available, award, counts, makeId};
});
