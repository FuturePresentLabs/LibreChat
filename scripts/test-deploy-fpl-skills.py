import importlib.util
from pathlib import Path
import unittest
import yaml

spec = importlib.util.spec_from_file_location(
    'deploy', Path(__file__).with_name('deploy-fpl-skills.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ComposeEditTest(unittest.TestCase):
    def test_preserves_unrelated_compose_tags_and_services(self):
        source = ('services:\n  api:\n    ports: !override\n      - "3080:3080"\n'
                  '  fpl-skills:\n    image: node:24-alpine\n    volumes:\n'
                  '      - /old:/app:ro\n  untouched:\n    image: busybox\n'
                  'volumes:\n  state: {}\n')
        result = deploy.replace_mapping(source, ['services', 'fpl-skills'], {
            'image': 'node:24-alpine', 'volumes': ['/new:/app:ro', 'state:/state']})
        self.assertIn('ports: !override\n      - "3080:3080"', result)
        self.assertIn('  untouched:\n    image: busybox\nvolumes:\n  state: {}', result)
        node = deploy.node_at(result, ['services', 'fpl-skills'])
        self.assertEqual(yaml.safe_load(yaml.serialize(node))['volumes'],
                         ['/new:/app:ro', 'state:/state'])

    def test_rejects_inline_mapping(self):
        with self.assertRaises(ValueError):
            deploy.replace_mapping('services:\n  api: {image: old}\n',
                                   ['services', 'api'], {'image': 'new'})


if __name__ == '__main__':
    unittest.main()
