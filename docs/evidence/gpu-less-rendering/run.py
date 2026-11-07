import pathlib,subprocess,json,secrets,time,urllib.request,sys
root=pathlib.Path('.cloakhub/gpu-less-evaluation').resolve()
image='ghcr.io/txchen/cloakhub_free:0.8.3'
s=(root/'launcher-original.ts').read_text()
old='["--disable-gpu", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"]'
assert s.count(old)==1
variants={'legacy':old,'auto':'[]','angle':'["--use-gl=angle", "--use-angle=swiftshader"]','no_disable_gpu':'["--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"]','only_disable_gpu':'["--disable-gpu"]'}
if '--repeat' in sys.argv:
 variants={'auto_r2':variants['auto'],'legacy_r2':variants['legacy']}
for i,(label,flags) in enumerate(variants.items()):
 d=root/label;d.mkdir(exist_ok=True);launcher=d/'launcher.ts';launcher.write_text(s.replace(old,flags));token=secrets.token_urlsafe(24);container='cloak-gpu-eval-'+label;port=7860+i
 config={'hub':f'http://127.0.0.1:{port}','token':token};(d/'config.json').write_text(json.dumps(config));(d/'config.json').chmod(0o600)
 env=d/'container.env';env.write_text('CLOAKHUB_AUTH_TOKEN='+token+'\n');env.chmod(0o600)
 try:
  subprocess.run(['docker','run','-d','--name',container,'--cpus=4','--shm-size=2g','--env-file',str(env),'-p',f'127.0.0.1:{port}:7788','-v',f'{launcher}:/app/src/browser-process-launcher.ts:ro',image],check=True,stdout=subprocess.DEVNULL)
  # No GPU devices, no privileged mode, no bind-mount of production data.
  info=json.loads(subprocess.check_output(['docker','inspect',container]))[0]
  assert not info['HostConfig']['Privileged'] and not info['HostConfig'].get('Devices') and not info['HostConfig'].get('DeviceRequests')
  check=subprocess.run(['docker','exec',container,'sh','-c','test ! -e /dev/dri && test ! -e /dev/nvidia0'],capture_output=True);assert check.returncode==0
  for _ in range(60):
   try:
    if urllib.request.urlopen(config['hub']+'/api/health',timeout=2).status==200:break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('health timeout')
  subprocess.run(['docker','cp',str(root/'fixture.mjs'),container+':/tmp/fixture.mjs'],check=True)
  subprocess.run(['docker','exec','-d',container,'bun','/tmp/fixture.mjs'],check=True)
  with (d/'test.log').open('w') as f:p=subprocess.run(['node',str(root/'check.mjs'),label],stdout=f,stderr=subprocess.STDOUT,timeout=240)
  (d/'environment.json').write_text(json.dumps({'image':info['Image'],'gpuDevicesAbsent':True,'privileged':False,'deviceRequests':info['HostConfig'].get('DeviceRequests'),'flags':json.loads(flags),'exit':p.returncode},indent=2))
  print(label,p.returncode,flush=True)
 finally:
  with (d/'container.log').open('w') as f:subprocess.run(['docker','logs',container],stdout=f,stderr=subprocess.STDOUT)
  subprocess.run(['docker','rm','-f','-v',container],stdout=subprocess.DEVNULL,check=False)
  env.unlink(missing_ok=True)
