import path from 'path';
import crypto from 'crypto';
import {
    NormalizedOutputOptions,
    OutputBundle,
    OutputChunk,
    PluginContext,
    PluginImpl,
    SourceMap,
    SourceMapInput
} from 'rollup';
import {createFilter} from 'rollup-pluginutils';
import {encode, decode} from 'sourcemap-codec';
import {readFileSync} from "fs";
import urljoin from 'url-join';

interface SourceMap {
    mappings: string,
    sources: string[],
    sourcesContent: string
}

interface PluginOptions {
    injectImports: boolean;
    injectType: 'link' | null;
    ignore: boolean;
    sourcemap: boolean;
    chunkFileNames: string;
    entryFileNames: string;
}

interface InputPluginOptions {
    injectImports?: boolean;
    injectType?: 'link' | null;
    ignore?: boolean;
    sourcemap?: boolean;
    chunkFileNames?: string;
    entryFileNames?: string;
    publicPath?: string;
    sourcemap?: boolean;
    emitFiles?: boolean;
}

function hash(content: string) {
    return crypto.createHmac('sha256', content)
        .digest('hex')
        .substr(0, 8);
}

function makeFileName(name: string, hashed: string, pattern: string) {
    return pattern.replace('[name]', name).replace('[hash]', hashed);
}

const INJECT_STYLES_NAME = 'inject_styles';
const INJECT_STYLES_ID = 'inject_styles.js';

const inject_styles = `
export default function(files) {
    return Promise.all(files.map(function(file) { return new Promise(function(fulfil, reject) {
        var href = new URL(file, import.meta.url);
        var baseURI = document.baseURI;

        if (!baseURI) {
            var baseTags = document.getElementsByTagName('base');
            baseURI = baseTags.length ? baseTags[0].href : document.URL;
        }

        var relative = ('' + href).substring(baseURI.length);
        var link = document.querySelector('link[rel=stylesheet][href="' + relative + '"]')
            || document.querySelector('link[rel=stylesheet][href="' + href + '"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            document.head.appendChild(link);
        }
        if (link.sheet) {
            fulfil();
        } else {
            link.onload = function() { return fulfil() };
            link.onerror = reject;
        }
    })}));
};`.trim();

const find_css = (chunk: RenderedChunk, bundle: OutputBundle) => {
    const css_files = new Set<string>();
    const visited = new Set<RenderedChunk>();

    const recurse = (c: RenderedChunk) => {
        if (visited.has(c)) return;
        visited.add(c);

        if (c.imports) {
            c.imports.forEach(file => {
                if (file.endsWith('.css')) {
                    css_files.add(file);
                } else {
                    const imported_chunk = <OutputChunk>bundle[file];
                    if (imported_chunk) {
                        recurse(imported_chunk);
                    }
                }
            });
        }
    };

    recurse(chunk);
    return Array.from(css_files);
};

const cssChunks: PluginImpl<InputPluginOptions> = function(options = {}) {
    const filter = createFilter(/\.css$/i, []);

    const defaultPluginOptions: PluginOptions = {
        injectImports: false,
        injectType: null,
        ignore: false,
        sourcemap: false,
        chunkFileNames: '[name]-[hash].css',
        entryFileNames: '[name].css',
    };

    Object.keys(options).forEach(key => {
        if (!(key in defaultPluginOptions))
            throw new Error(`unknown option ${key}`);
    });
    const pluginOptions = Object.assign({}, defaultPluginOptions, options);

    const css_data: Record<string, {
        code: string,
        map: SourceMap
    }> = {};

    return {
        name: 'css',

        buildStart(this: PluginContext): void {
            if (!pluginOptions.injectType) {
                return;
            }

            this.emitFile({
                type: 'chunk',
                id: INJECT_STYLES_ID,
                name: INJECT_STYLES_NAME,
                preserveSignature: 'allow-extension'
            });
        },

        load(id: string) {
            return id === INJECT_STYLES_ID ? inject_styles : null;
        },

        resolveId(importee: string) {
            return importee === INJECT_STYLES_ID ? INJECT_STYLES_ID : null;
        },

        renderDynamicImport({ targetModuleId }) {
            if (pluginOptions.injectType && targetModuleId) {
                return {
                    left: 'Promise.all([import(',
                    right: `), ___CSS_INJECTION___${Buffer.from(targetModuleId).toString('hex')}___]).then(function(x) { return x[0]; })`
                };
            } else {
                return {
                    left: 'import(',
                    right: ')'
                };
            }
        },

        transform(code: string, id: string) {
            if (!filter(id)) return null;

            let code = readFileSync(id, 'utf8');
            let map: SourceMapInput = null;

            let m = code.match(/\/\*#\W*sourceMappingURL=data:application\/json;charset=utf-8;base64,([a-zA-Z0-9+/]+)\W*\*\//);
            if (m !== null) {
                code = code.replace(m[0], '').trim();
                try {
                    map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8').trim());
                } catch (err) {
                    console.warn(`Could not load css map file of ${id}.\n  ${err}`);
                }
            }
            m = code.match(/\/\*#\W*sourceMappingURL=([^\\/]+)\W*\*\//);
            if (m !== null) {
                code = code.replace(m[0], '').trim();
                try {
                    map = readFileSync(path.resolve(id, '..', m[1].trim()), 'utf8');
                } catch (err) {
                    console.warn(`Could not load css map file of ${id}.\n  ${err}`);
                }
            }

            return {code, map}
        },

        transform(code: string, id: string) {
            if (!filter(id)) return null;
            css_data[id] = {code, map: this.getCombinedSourcemap()};
            return {code: `export default import.meta.CSS_URL;`, map: null, meta: {transformedByCSSChunks: true}};
        },

        resolveImportMeta(property, options) {
            if (property == 'CSS_URL') {
                return `"CSS_FILE_${options.chunkId}"`;
            }
            return null;
        },

        generateBundle(this: PluginContext, generateBundleOpts: NormalizedOutputOptions, bundle: OutputBundle) {
            let emitFiles = pluginOptions.emitFiles;
            if (!generateBundleOpts.dir) {
                this.warn('No directory provided. Skipping CSS generation');
                emitFiles = false;
            }

            for (const chunk of Object.values(bundle).reverse()) {
                if (chunk.type === 'asset') continue;

                let code = '';

                if (pluginOptions.injectImports) {
                    for (const c of chunk.imports) {
                        if (bundle[c]) {
                            code += (<OutputChunk>bundle[c]).imports.filter(filter)
                                .map(f => `@import '${f}';`).join('');
                        }
                    }
                    if (code != '')
                        code += '\n';
                }

                const css_modules: string[] = []
                for (const f of Object.keys(chunk.modules)) {
                    this.getModuleInfo(f)?.importedIds
                        ?.filter(v => this.getModuleInfo(v)?.meta.transformedByCSSChunks == true)
                        .forEach(v => css_modules.push(v));
                }

                const sources = [];
                const sourcesContent = [];
                const mappings = [];
                for (const f of css_modules) {
                    if (pluginOptions.sourcemap && emitFiles) {
                        const i = sources.length;
                        sources.push(...css_data[f].map.sources.map(
                            source => path.relative(generateBundleOpts.dir ? generateBundleOpts.dir : '', source)));
                        if (css_data[f].map.sourcesContent) {
                            sourcesContent.push(...css_data[f].map.sourcesContent);
                        }
                        const decoded = decode(css_data[f].map.mappings);
                        if (i === 0) {
                            decoded[0].forEach(segment => {
                                segment[0] += code.length;
                            });
                        }
                        if (i > 0) {
                            decoded.forEach(line => {
                                line.forEach(segment => {
                                    segment[1] = i;
                                });
                            });
                        }
                        mappings.push(...decoded);
                    }
                    code += css_data[f].code + '\n';
                }

                if (code === '') continue;

                const css_file_name = makeFileName(chunk.name, hash(code),
                    chunk.isEntry ? pluginOptions.entryFileNames : pluginOptions.chunkFileNames);

                const css_file_url = urljoin(pluginOptions.publicPath, css_file_name);
                chunk.code = chunk.code.replace(new RegExp(`CSS_FILE_${chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), css_file_url);

                if (emitFiles) {
                    if (emitFiles && pluginOptions.sourcemap) {
                        let map = null;
                        const map_file_name = css_file_name + '.map';
                        map = {
                            version: 3,
                            file: css_file_name,
                            sources: sources,
                            sourcesContent: sourcesContent,
                            names: [],
                            mappings: encode(mappings)
                        };
                        code += `/*# sourceMappingURL=${encodeURIComponent(map_file_name)} */`;
                        this.emitFile({
                            type: 'asset',
                            fileName: map_file_name,
                            source: JSON.stringify(map, null)
                        });
                    }
                    this.emitFile({
                        type: 'asset',
                        fileName: css_file_name,
                        source: code
                    });
                    chunk.imports.push(css_file_name);
                }
            }

            if (!pluginOptions.injectType) {
                return;
            }
            const inject_styles_file = Object.keys(bundle).find(f => f.startsWith('inject_styles'));

            let has_css = false;
            for (const name in bundle) {
                const chunk = <OutputChunk>bundle[name];

                let chunk_has_css = false;

                if (chunk.code) {
                    chunk.code = chunk.code.replace(/___CSS_INJECTION___([0-9a-f]+)___/g, (m, id) => {
                        id = Buffer.from(id, 'hex').toString();
                        const target = <OutputChunk>Object.values(bundle)
                            .find(c => (<OutputChunk>c).modules && (<OutputChunk>c).modules[id]);

                        if (target) {
                            const css_files = find_css(target, bundle);
                            if (css_files.length > 0) {
                                chunk_has_css = true;
                                return `__inject_styles(${JSON.stringify(css_files)})`;
                            }
                        }

                        return '';
                    });

                    if (chunk_has_css) {
                        has_css = true;
                        chunk.code = `import __inject_styles from './${inject_styles_file}';\n` + chunk.code;
                    }
                }
            }

            if (inject_styles_file && !has_css) {
                delete bundle[inject_styles_file];
            }
        }
    };
};

export default cssChunks;
