const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inside, associate } = require('../src/model.cjs');
test('Windows project paths match only complete boundaries', () => {
  assert.equal(inside('node "C:\\Projects\\Lilsi\\server.js"','C:\\Projects\\Lilsi'),true);
  assert.equal(inside('node C:\\Projects\\Lilsi-old\\server.js','C:\\Projects\\Lilsi'),false);
  assert.equal(inside('node C:/PROJECTS/LILSI/server.js','c:\\projects\\lilsi'),true);
});
test('Port alone does not assign an external process', () => {
  const result = associate([{pid:10,command:'node server.js',ports:[3000]}],[{id:'p',directory:'C:\\Projects\\App'}],new Map());
  assert.equal(result[0].projectId,null);
});
test('Managed descendants inherit service ownership', () => {
  const result = associate([{pid:10,parentPid:1},{pid:11,parentPid:10},{pid:12,parentPid:11}],[],new Map([[10,{projectId:'p',serviceId:'s'}]]));
  assert.equal(result[2].serviceId,'s'); assert.equal(result[2].managed,true);
});
test('Ambiguous paths remain unassigned', () => {
  const result = associate([{pid:10,command:'node C:\\Projects\\App\\server.js'}],[{id:'a',directory:'C:\\Projects'},{id:'b',directory:'C:\\Projects\\App'}],new Map());
  assert.equal(result[0].projectId,null);
});
test('Parent process cycles terminate safely', () => {
  assert.equal(associate([{pid:1,parentPid:2},{pid:2,parentPid:1}],[],new Map())[0].projectId,null);
});
