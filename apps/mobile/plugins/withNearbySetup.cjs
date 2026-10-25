const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = function withNearbySetup(config) {
  config = withAndroidManifest(config, mod => {
    const application = mod.modResults.manifest.application[0];
    const existing = application.$['android:networkSecurityConfig'];
    if (existing && existing !== '@xml/beehave_nearby_network') throw new Error('Existing network security configuration needs review before adding nearby setup.');
    application.$['android:networkSecurityConfig'] = '@xml/beehave_nearby_network';
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'beehave_nearby_network.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">local</domain>
  </domain-config>
</network-security-config>\n`);
    // Preserve Expo's existing debug-only HTTP behavior when its manifest opts in.
    // Release builds retain platform defaults outside the .local exception.
    const debugRoot = path.join(mod.modRequest.platformProjectRoot, 'app/src/debug');
    const debugManifest = await fs.readFile(path.join(debugRoot, 'AndroidManifest.xml'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (/android:usesCleartextTraffic="true"/.test(debugManifest)) {
      const debugXml = path.join(debugRoot, 'res/xml');
      await fs.mkdir(debugXml, { recursive: true });
      await fs.writeFile(path.join(debugXml, 'beehave_nearby_network.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config><base-config cleartextTrafficPermitted="true" /></network-security-config>\n`);
    }
    return mod;
  }]);
};
