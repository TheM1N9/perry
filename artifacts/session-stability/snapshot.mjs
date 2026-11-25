import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function snapshotBuild(repo, root, output) {
  const source = join(repo, '.next');
  const buildId = readFileSync(join(source, 'BUILD_ID'), 'utf8').trim();
  const required = JSON.parse(readFileSync(join(source, 'required-server-files.json'), 'utf8'));
  const destination = join(root, 'project');
  mkdirSync(join(destination, '.next'), { recursive: true });
  for (const name of ['server', 'static']) cpSync(join(source, name), join(destination, '.next', name), { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(join(source, entry.name), join(destination, '.next', entry.name));
  }
  cpSync(join(repo, 'public'), join(destination, 'public'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(destination, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(destination, 'node_modules'), 'junction');
  const aliases = [];
  const copyAliases = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const original = join(from, entry.name), target = join(to, entry.name);
      if (entry.isSymbolicLink()) {
        const dependency = realpathSync(original);
        assert.ok(dependency.toLowerCase().startsWith(join(repo, 'node_modules').toLowerCase() + sep), 'Generated alias targets an existing dependency');
        symlinkSync(dependency, target, 'junction');
        aliases.push({ path: relative(destination, target), target: dependency });
      } else if (entry.isDirectory()) copyAliases(original, target);
      else cpSync(original, target);
    }
  };
  copyAliases(join(source, 'node_modules'), join(destination, '.next', 'node_modules'));
  for (const file of required.files) {
    const target = resolve(destination, file);
    assert.ok(target.startsWith(destination + sep), 'Required server file stays inside snapshot');
    assert.ok(existsSync(target), `Required server file copied: ${file}`);
  }
  const files = [];
  const inventory = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) inventory(target);
      else {
        const name = relative(destination, target);
        const bytes = readFileSync(target);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const original = readFileSync(join(repo, name));
        assert.equal(hash, createHash('sha256').update(original).digest('hex'), `Snapshot hash: ${name}`);
        files.push({ path: name, bytes: bytes.length, sha256: hash });
      }
    }
  };
  inventory(destination);
  assert.equal(readFileSync(join(source, 'BUILD_ID'), 'utf8').trim(), buildId, 'Source build stayed fixed during copy');
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(bytes < 150 * 1024 * 1024, 'Snapshot fits within 150 MiB allocation');
  writeFileSync(join(output, 'snapshot-manifest.json'), JSON.stringify({ buildId, source, requiredFiles: required.files, bytes, files, aliases }, null, 2));
  // This is the installed Next standalone launcher's native startServer path.
  writeFileSync(join(destination, 'server.cjs'), `process.env.NODE_ENV='production'; process.chdir(__dirname); const config=require('./.next/required-server-files.json').config; process.env.__NEXT_PRIVATE_STANDALONE_CONFIG=JSON.stringify(config); require('next'); require('next/dist/server/lib/start-server').startServer({dir:__dirname,isDev:false,config,hostname:'127.0.0.1',port:Number(process.env.PERRY_PORT),allowRetry:false}).catch(error=>{console.error(error);process.exit(1)});`);
  return { root: destination, launcher: join(destination, 'server.cjs'), buildId, bytes, files: files.length, aliases: aliases.length, source, requiredFiles: required.files.length };
}
