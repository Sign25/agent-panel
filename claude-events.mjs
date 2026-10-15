// Normalize SDK tool lifecycle without treating the end of tool input as execution completion.
export function claudeEvents(event){
 let messageId='',blocks=new Map();const tools=new Map();
 const emit=(method,params)=>event(method,params);
 function start(c,status='inProgress'){
  const item={...(tools.get(c.id)||{}),id:c.id,type:c.name==='Bash'?'commandExecution':'toolCall',tool:c.name,input:c.input||{},status};tools.set(c.id,item);emit('item/started',{item});return item;
 }
 function text(content){if(typeof content==='string')return content;if(!Array.isArray(content))return '';return content.map(c=>c.type==='text'?c.text:c.type==='image'?'[Изображение в результате инструмента]':c.type==='resource_link'?'[Ресурс: '+(c.name||c.uri||'')+']':'').filter(Boolean).join('\n');}
 return m=>{
  if(m.type==='stream_event'){
   const e=m.event;
   if(e.type==='message_start'){messageId=e.message.id;blocks=new Map();}
   if(e.type==='content_block_start'){
    const c=e.content_block,id=c.type==='tool_use'?c.id:messageId+':'+e.index;blocks.set(e.index,{id,type:c.type});
    if(c.type==='tool_use')start(c,'preparing');else emit('item/started',{item:{id,type:c.type==='thinking'?'reasoning':'agentMessage'}});
   }
   if(e.type==='content_block_delta'&&e.delta.type==='text_delta')emit('item/agentMessage/delta',{itemId:messageId,delta:e.delta.text});
   if(e.type==='content_block_delta'&&e.delta.type==='input_json_delta'){
    const block=blocks.get(e.index);if(block?.type==='tool_use')emit('item/toolCall/inputDelta',{itemId:block.id,delta:e.delta.partial_json});
   }
   if(e.type==='content_block_stop'){
    const block=blocks.get(e.index);if(block&&block.type!=='tool_use')emit('item/completed',{item:{id:block.id,type:block.type==='thinking'?'reasoning':'agentMessage'}});
   }
  }
  if(m.type==='assistant'){
   for(const c of m.message.content||[])if(c.type==='tool_use')start(c);
   const value=text((m.message.content||[]).filter(c=>c.type==='text'));if(value)emit('item/completed',{item:{id:m.message.id,type:'agentMessage',text:value}});
  }
  if(m.type==='user'&&Array.isArray(m.message.content))for(const c of m.message.content)if(c.type==='tool_result'){
   const old=tools.get(c.tool_use_id)||{id:c.tool_use_id,type:'toolCall'};
   const output=text(c.content);const item={...old,status:c.is_error?'failed':'completed',output,isError:!!c.is_error};
   // Preserve SDK metadata when available; the tool_result text remains the canonical visible result.
   if(m.tool_use_result&&typeof m.tool_use_result==='object'){
    const r=m.tool_use_result;
    if(Number.isInteger(r.exitCode))item.exitCode=r.exitCode;
    if(Number.isInteger(r.exit_code))item.exitCode=r.exit_code;
    if(typeof r.stdout==='string'&&!output)item.output=r.stdout+(typeof r.stderr==='string'?'\n'+r.stderr:'');
    if(r.detachedToolCall||r.backgroundTaskId||r.background_task_id)item.status='background';
   }
   tools.set(item.id,item);emit('item/completed',{item});
  }
  // A resumed session may still report progress of commands from an earlier turn; they are not part of this turn.
  if(m.type==='tool_progress'&&tools.has(m.tool_use_id)){
   const old=tools.get(m.tool_use_id);
   const item={...old,status:'inProgress',elapsedSeconds:m.elapsed_time_seconds};tools.set(item.id,item);emit('item/progress',{item});
  }
  if(m.type==='tool_use_summary')emit('tool/summary',{id:m.uuid,summary:m.summary,itemIds:m.preceding_tool_use_ids});
  if(m.type==='system'&&m.subtype==='task_notification'&&m.tool_use_id){
   const old=tools.get(m.tool_use_id)||{id:m.tool_use_id,type:'toolCall'};
   const item={...old,status:m.status==='completed'?'completed':m.status==='failed'?'failed':'interrupted',summary:m.summary};tools.set(item.id,item);emit('item/completed',{item});
  }
 };
}
