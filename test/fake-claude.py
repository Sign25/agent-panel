#!/usr/bin/python3
import sys,json,threading
args=sys.argv[1:]
if args[:2]==['auth','status']:
 print(json.dumps({'loggedIn':True,'authMethod':'claude.ai'}));sys.exit()
def emit(x):print(json.dumps(x),flush=True)
session='11111111-1111-4111-8111-111111111111'
for arg in args:
 if arg.startswith('--resume='):session=arg.split('=',1)[1]
if '--fork-session' in args:session='33333333-3333-4333-8333-333333333333'
user=None
joined=[]
initialization=None
# A resume of a session whose file is gone fails the way Claude Code does.
if session.startswith('98989898-'):
 for line in sys.stdin:
  m=json.loads(line)
  if m.get('type')=='control_request':emit({'type':'control_response','response':{'subtype':'success','request_id':m['request_id'],'response':{'models':[],'commands':[],'agents':[]}}})
  if m.get('type')=='user':emit({'type':'result','subtype':'error_during_execution','is_error':True,'session_id':session,'errors':['No conversation found with session ID: '+session]});break
 sys.exit(0)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('type')=='control_request':
  initialization=m.get('request')
  if m['request'].get('subtype')=='get_usage':
   emit({'type':'control_response','response':{'subtype':'success','request_id':m['request_id'],'response':{'rate_limits_available':True,'rate_limits':{'five_hour':{'utilization':2,'resets_at':'2026-10-09T15:30:00Z'},'seven_day':{'utilization':21,'resets_at':'2026-10-12T11:00:00Z'}}}}});continue
  response={'models':[{'value':'claude-test','displayName':'Claude Test','supportsEffort':True,'supportedEffortLevels':['low','high']}],'commands':[],'agents':[]}
  emit({'type':'control_response','response':{'subtype':'success','request_id':m['request_id'],'response':response}})
 if m.get('type')=='user' and user is not None and m['message']['content'][0]['text'].startswith('joined'):
  # A message sent while the turn runs is picked up by that turn, as Claude Code does.
  joined.append(m['message']['content'][0]['text']);continue
 if m.get('type')=='user':
  user=m
  if m['message']['content'][0]['text']=='crash':sys.exit(1)
  # A resumed session closing a hanging terminal turn before our prompt.
  if m['message']['content'][0]['text'].startswith('dangling'):emit({'type':'result','subtype':'success','is_error':False,'session_id':session,'result':''})
  emit({'type':'system','subtype':'init','session_id':session,'tools':['Read','Bash'],'model':'claude-test'})
  emit({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool','tool_name':'Bash','input':{'command':'echo fixture'},'tool_use_id':'tool-1'}})
 if m.get('type')=='control_response' and m.get('response',{}).get('request_id')=='permission-1':
  text=json.dumps({'decision':m['response']['response'],'args':args,'user':user,'initialization':initialization,'joined':joined})
  emit({'type':'assistant','session_id':session,'message':{'id':'tool-message','content':[{'type':'tool_use','id':'tool-1','name':'Bash','input':{'command':'echo fixture'}}]}})
  emit({'type':'tool_progress','session_id':session,'uuid':'progress-fixture','tool_use_id':'tool-1','tool_name':'Bash','parent_tool_use_id':None,'elapsed_time_seconds':2})
  emit({'type':'user','session_id':session,'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'tool-1','content':'fixture tool output','is_error':m['response']['response']['behavior']=='deny'}]},'parent_tool_use_id':None})
  emit({'type':'stream_event','session_id':session,'event':{'type':'message_start','message':{'id':'answer-1'}}})
  emit({'type':'stream_event','session_id':session,'event':{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}})
  emit({'type':'stream_event','session_id':session,'event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Проверено'}}})
  emit({'type':'assistant','session_id':session,'message':{'id':'answer-1','content':[{'type':'text','text':text}]}})
  background=user['message']['content'][0]['text'].startswith('background')
  # A subagent launched in the background outlives the turn and reports back later, starting a follow-up turn.
  if background:emit({'type':'system','subtype':'background_tasks_changed','session_id':session,'tasks':[{'task_id':'bg-1','task_type':'local_agent','description':'Review A'}]})
  emit({'type':'result','subtype':'success','is_error':False,'session_id':session,'result':text})
  if background:
   def report():
    emit({'type':'system','subtype':'background_tasks_changed','session_id':session,'tasks':[]})
    emit({'type':'assistant','session_id':session,'message':{'id':'answer-2','content':[{'type':'text','text':'Фоновая проверка готова'}]}})
    emit({'type':'result','subtype':'success','is_error':False,'session_id':session,'result':'Фоновая проверка готова'})
   threading.Timer(1.0,report).start()
