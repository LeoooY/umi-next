import { init, parse } from '@umijs/bundler-utils/compiled/es-module-lexer';
import { Loader, transformSync } from '@umijs/bundler-utils/compiled/esbuild';
import { pkgUp } from '@umijs/utils';
import assert from 'assert';
import enhancedResolve from 'enhanced-resolve';
import { readFileSync } from 'fs';
import { dirname, extname } from 'path';

enum ImportType {
  import = 'import',
  dynamicImport = 'dynamicImport',
  export = 'export',
}

interface Dep {
  url: string;
  importType: ImportType;
  // 只有 opts.needDepSpecifier 为 true 时才返回
  specifiers?: 'namespace' | string[]; // default 用特殊字符串 __default__
}

// 项目文件都是 esm，无需考虑 cjs
export async function scanContent(opts: {
  content: string;
  needDepSpecifier?: boolean;
}): Promise<{ deps: Dep[] }> {
  await init;
  const [imports] = parse(opts.content);
  const deps = imports.map((imp) => {
    let importType = ImportType.import;
    if (imp.d > -1) importType = ImportType.dynamicImport;
    if (opts.content.slice(imp.ss, imp.se).startsWith('export ')) {
      importType = ImportType.export;
    }
    return {
      url: imp.n as string,
      importType,
    };
  });
  return { deps };
}

export async function getContent(path: string) {
  let content = readFileSync(path, 'utf-8');
  // es-module-lexer don't support jsx
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) {
    content = transformSync(content, {
      loader: extname(path).slice(1) as Loader,
      format: 'esm',
    }).code;
  }
  return content;
}

export function createResolver(opts: { alias: any }) {
  const resolver = enhancedResolve.create({
    mainFields: ['module', 'browser', 'main'], // es module first
    extensions: ['.js', '.json', '.mjs', '.ts', '.tsx'],
    exportsFields: [],
    alias: opts.alias,
  });
  async function resolve(context: string, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      resolver(context, path, (err: Error, result: string) =>
        err ? reject(err) : resolve(result),
      );
    });
  }
  return { resolve };
}

export async function scan(opts: {
  entry: string;
  externals: any;
  resolver: any;
}): Promise<Record<string, string>> {
  const cache = new Map<string, any>();
  const queueDeps: string[] = [opts.entry];
  const ret: Record<string, string> = {};
  while (queueDeps.length) {
    const depPath = queueDeps.shift();
    if (cache.has(depPath!)) continue;
    const content = await getContent(depPath!);
    const { deps } = await scanContent({ content });
    cache.set(depPath!, deps);

    for (const dep of deps) {
      const resolved = await opts.resolver.resolve(dirname(depPath!), dep.url);
      if (
        resolved.includes('node_modules') ||
        resolved.includes('umi-next/packages')
      ) {
        const pkgPath = pkgUp.sync({ cwd: resolved });
        assert(pkgPath, `package.json for found for ${resolved}`);
        const pkg = require(pkgPath);
        ret[pkg.name] = pkg.version;
      } else if (
        ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(resolved))
      ) {
        queueDeps.push(resolved);
      }
    }
  }
  return ret;
}