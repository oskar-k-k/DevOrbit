const { test } = require('node:test');
const assert = require('node:assert/strict');
const { panelBounds, projectProcesses } = require('../src/panel.cjs');
test('Panel anchors inside the tray monitor work area, including negative coordinates', () => {
  assert.deepEqual(panelBounds({x:-1920,y:0,width:1920,height:1040}), {width:440,height:640,x:-448,y:392});
  const bounds = panelBounds({x:0,y:0,width:400,height:500});
  assert.equal(bounds.width,384); assert.equal(bounds.height,484); assert.equal(bounds.x,8); assert.equal(bounds.y,8);
});
test('Only known project processes are exposed; unrelated TCP listeners are excluded', () => {
  const result = projectProcesses([{pid:1,ports:[3000],projectId:null},{pid:2,projectId:'p'},{pid:3,projectId:'deleted'}],[{id:'p'}]);
  assert.deepEqual(result.map(p=>p.pid),[2]);
});
test('Manual assignment requires matching process lifetime and an existing project', () => {
  const result = projectProcesses([{pid:1,created:'new'},{pid:2,created:'same'}],[{id:'p'}], {'1':{created:'old',projectId:'p'},'2':{created:'same',projectId:'p'}});
  assert.deepEqual(result.map(p=>p.pid),[2]);
});
