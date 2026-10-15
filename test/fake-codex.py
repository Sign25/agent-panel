#!/usr/bin/python3
import sys,json,os
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); result=None
 if method=='model/list': result={'data':[{'model':'test-model','displayName':'Test','isDefault':True,'defaultReasoningEffort':'medium','supportedReasoningEfforts':[{'reasoningEffort':'medium'},{'reasoningEffort':'high'}]}],'nextCursor':None}
 if method=='turn/start':
  print(json.dumps({'method':'test/settings','params':m['params']}),flush=True)
 if method=='initialize': result={}
 if method=='account/read': result={'account':{'type':'chatgpt'}}
 if method in ('thread/start','thread/resume','thread/fork'):
  result={'thread':{'id':'thread-forked' if method=='thread/fork' else 'thread-test'}}
  print(json.dumps({'method':'test/thread-settings','params':{**m['params'],'rpc':method}}),flush=True)
 # Threads started outside the panel, described by the test through CODEX_FAKE_THREADS.
 if method=='thread/list':
  result={'data':json.loads(os.environ.get('CODEX_FAKE_THREADS','[]')),'nextCursor':None}
 if method=='thread/read':
  result={'thread':{'id':m['params']['threadId'],'name':'TUI work','cwd':'/','turns':[{'id':'t1','items':[{'type':'userMessage','id':'u','content':[{'type':'text','text':'Собери релиз'}]},{'type':'reasoning','id':'r'},{'type':'agentMessage','id':'a','text':'Релиз собран'}]}]}}
 if method=='turn/start': result={'turn':{'id':'turn-test'}}
 if method=='turn/interrupt': result={}
 if result is not None: print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/start':
  print(json.dumps({'method':'turn/started','params':{'turn':{'id':'turn-test'}}}),flush=True)
  print(json.dumps({'id':99,'method':'item/commandExecution/requestApproval','params':{'command':'echo test'}}),flush=True)
 if m.get('id')==99 and 'result' in m:
  print(json.dumps({'method':'item/agentMessage/delta','params':{'itemId':'answer','delta':'Проверено'}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'turn':{'status':'completed'}}}),flush=True)
