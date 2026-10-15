import {test} from 'node:test';import assert from 'node:assert/strict';
import {claudeEvents} from '../claude-events.mjs';
test('Claude tool input completion is not execution completion; results, progress, parallel ids survive',()=>{
 const events=[];const feed=claudeEvents((method,params)=>events.push({method,params}));const stream=event=>feed({type:'stream_event',event});
 stream({type:'message_start',message:{id:'m1'}});
 stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'bash-1',name:'Bash',input:{}}});
 stream({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"command":"npm test"}'}});
 stream({type:'content_block_stop',index:0});
 assert.equal(events.filter(e=>e.method==='item/completed').length,0);
 assert.equal(events[0].params.item.id,'bash-1');assert.equal(events[0].params.item.status,'preparing');
 feed({type:'assistant',message:{id:'m1',content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'read-2',name:'Read',input:{file_path:'/project/README'}}]}});
 feed({type:'tool_progress',tool_use_id:'bash-1',tool_name:'Bash',elapsed_time_seconds:7});
 feed({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-2',content:[{type:'text',text:'Documentation'},{type:'image',source:{data:'secret-binary'}}]}]}});
 feed({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-1',is_error:true,content:'Test failed\nActual stderr'}]},tool_use_result:{exitCode:1}});
 const done=events.filter(e=>e.method==='item/completed').map(e=>e.params.item);
 assert.equal(done.length,2);assert.equal(done[0].id,'read-2');assert.match(done[0].output,/Documentation/);assert.ok(!done[0].output.includes('secret-binary'));
 assert.equal(done[1].id,'bash-1');assert.equal(done[1].status,'failed');assert.equal(done[1].output,'Test failed\nActual stderr');assert.equal(done[1].exitCode,1);assert.equal(done[1].input.command,'npm test');
 assert.equal(events.find(e=>e.method==='item/progress').params.item.elapsedSeconds,7);
 feed({type:'user',message:{content:'Ordinary user text'}});assert.equal(events.filter(e=>e.method==='item/completed').length,2);
});
test('Claude background completion remains correlated to original tool',()=>{
 const events=[];const feed=claudeEvents((method,params)=>events.push({method,params}));
 feed({type:'assistant',message:{id:'m',content:[{type:'tool_use',id:'job',name:'Bash',input:{command:'long-job'}}]}});
 feed({type:'user',message:{content:[{type:'tool_result',tool_use_id:'job',content:'Background task'}]},tool_use_result:{backgroundTaskId:'task'}});
 assert.equal(events.at(-1).params.item.status,'background');
 feed({type:'system',subtype:'task_notification',tool_use_id:'job',status:'completed',summary:'Job succeeded'});
 assert.equal(events.at(-1).params.item.id,'job');assert.equal(events.at(-1).params.item.status,'completed');assert.equal(events.at(-1).params.item.summary,'Job succeeded');
});
