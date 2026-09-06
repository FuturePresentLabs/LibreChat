"""Run on Batty with sudo python3 stdin: IMAGE SKILLS_COMMIT VERIFY_EMAIL.

Requires an already-pulled immutable image and git archive at /tmp/skills-COMMIT.
Credentials stay on the host. Existing Compose configuration is backed up privately.
"""
import copy
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import yaml

ROOT = Path('/home/ajmwagar/librechat')
FILES = [ROOT / name for name in (
    'docker-compose.yml', 'docker-compose.override.yaml', 'docker-compose.fpl.yml')]


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)


def node_at(source, keys):
    node = yaml.compose(source)
    for key in keys:
        node = next(value for name, value in node.value if name.value == key)
    return node


def replace_mapping(source, keys, value):
    # Edit only this mapping so unrelated Compose !override tags survive intact.
    node = node_at(source, keys)
    if not isinstance(node, yaml.MappingNode) or node.flow_style:
        raise ValueError('Expected a block mapping')
    lines = source.splitlines(keepends=True)
    replacement = textwrap.indent(yaml.safe_dump(value, sort_keys=False),
                                  ' ' * node.start_mark.column)
    return ''.join(lines[:node.start_mark.line]) + replacement + ''.join(lines[node.end_mark.line:])


def write(path, content):
    stat = path.stat()
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.skills-release-')
    try:
        os.fchown(fd, stat.st_uid, stat.st_gid)
        with os.fdopen(fd, 'w') as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def compose(*args):
    command = ['docker', 'compose']
    for path in FILES:
        command.extend(['-f', str(path)])
    return run(*command, *args)


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def environment(container):
    return dict(item.split('=', 1) for item in container['Config']['Env'])


def mounts(container, exclude=()):
    return sorted((m for m in container['Mounts'] if m['Destination'] not in exclude),
                  key=lambda m: m['Destination'])


def probe(container, url):
    run('docker', 'exec', container, 'node', '-e', '''
    (async()=>{for(let i=0;i<60;i++){
      try{const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(2000)});
        if(r.ok)return;}catch{}
      await new Promise(r=>setTimeout(r,1000));
    }throw Error('Health check failed')})().catch(()=>process.exit(1));
    ''', url)


def main(image, commit, email):
    if not re.fullmatch(r'[0-9a-f]{7,40}', commit):
        raise ValueError('Expected a Skills commit')
    if not re.fullmatch(r'registry-direct\.fpl\.dev/librechat:(sha-[0-9a-f]{40})', image):
        raise ValueError('Expected an immutable LibreChat SHA tag')
    target = json.loads(run('docker', 'image', 'inspect', image))[0]['Id']
    original = {path: path.read_text() for path in FILES[1:]}
    before = json.loads(compose('config', '--format', 'json'))
    chat = inspect('LibreChat')
    skills = inspect('librechat-fpl-skills-1')
    if not chat['State']['Running'] or not skills['State']['Running']:
        raise RuntimeError('Both services must already be running')
    release = Path('/home/ajmwagar/fpl-skills-releases') / commit
    shutil.copytree(Path('/tmp') / ('skills-' + commit), release)
    backup = ROOT / 'backups' / ('skills-' + datetime.datetime.now(
        datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700, parents=True)
    for path, source in original.items():
        (backup / path.name).write_text(source)
    api = yaml.safe_load(yaml.serialize(node_at(original[FILES[2]], ['services', 'api'])))
    api['image'] = image
    settings = api.setdefault('environment', {})
    if not isinstance(settings, dict):
        raise ValueError('Expected API environment mapping')
    settings.update(FPL_SKILLS_URL='http://fpl-skills:8793',
                    FPL_SKILLS_TOKEN=environment(skills)['MCP_GATEWAY_SHARED_TOKEN'])
    service = yaml.safe_load(yaml.serialize(node_at(original[FILES[1]], ['services', 'fpl-skills'])))
    old_source = next(m['Source'] for m in skills['Mounts'] if m['Destination'] == '/app')
    old_mount = old_source + ':/app:ro'
    if service['volumes'].count(old_mount) != 1:
        raise ValueError('Unexpected Skills source mount')
    service['volumes'] = [str(release) + ':/app:ro' if m == old_mount else m
                          for m in service['volumes']]
    try:
        write(FILES[1], replace_mapping(original[FILES[1]], ['services', 'fpl-skills'], service))
        write(FILES[2], replace_mapping(original[FILES[2]], ['services', 'api'], api))
        after = json.loads(compose('config', '--format', 'json'))
        expected = copy.deepcopy(before)
        expected['services']['api']['image'] = image
        expected['services']['api']['environment'].update({key: settings[key] for key in
                                                          ('FPL_SKILLS_URL', 'FPL_SKILLS_TOKEN')})
        for mount in expected['services']['fpl-skills']['volumes']:
            if mount['target'] == '/app':
                mount['source'] = str(release)
        if expected != after:
            raise RuntimeError('Unexpected merged Compose change')
        compose('up', '-d', '--no-deps', '--pull', 'never', 'fpl-skills')
        probe('librechat-fpl-skills-1', 'http://127.0.0.1:8793/health')
        compose('up', '-d', '--no-deps', '--pull', 'never', 'api')
        probe('LibreChat', 'http://127.0.0.1:3080/health')
        live = inspect('LibreChat')
        live_skills = inspect('librechat-fpl-skills-1')
        if live['Image'] != target or mounts(live) != mounts(chat):
            raise RuntimeError('Image or mounts differ from expected')
        if mounts(live_skills, ('/app',)) != mounts(skills, ('/app',)):
            raise RuntimeError('Persistent Skills mounts changed')
        if environment(live_skills) != environment(skills):
            raise RuntimeError('Skills credentials changed')
        ignored = {'FPL_SKILLS_URL', 'FPL_SKILLS_TOKEN', 'BUILD_COMMIT', 'BUILD_BRANCH', 'BUILD_DATE'}
        if {k:v for k,v in environment(chat).items() if k not in ignored} != {
                k:v for k,v in environment(live).items() if k not in ignored}:
            raise RuntimeError('Unexpected API environment change')
        run('docker', 'exec', 'LibreChat', 'node', '-e', '''
        (async()=>{
          const {createFplSkillProvider}=require('@librechat/api');
          const provider=createFplSkillProvider({provider:'openid',email:process.argv[1],
            openidId:'release-verification',id:'000000000000000000000001'});
          if(!provider)throw Error('Missing provider');
          await provider.ids([]);
          const r=await fetch(process.env.FPL_SKILLS_URL+'/library');
          if(r.status!==401)throw Error('Skills authentication missing');
          const chat=await fetch('http://127.0.0.1:3080/api/skills');
          if(chat.status!==401)throw Error('Chat authentication missing');
        })().catch(()=>process.exit(1));
        ''', email)
    except Exception:
        for path, source in original.items():
            write(path, source)
        compose('up', '-d', '--no-deps', '--pull', 'never', 'fpl-skills', 'api')
        probe('LibreChat', 'http://127.0.0.1:3080/health')
        raise RuntimeError('Release failed; previous configuration restored') from None
    print(json.dumps({'image': image, 'skills_commit': commit, 'backup': str(backup),
                      'health': 'passed', 'identity_and_access_checks': 'passed'}))


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except Exception as error:
        print('Deployment failed (' + type(error).__name__ + '). Inspect private backup on Batty.')
        sys.exit(1)
