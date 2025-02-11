# rollup-plugin-css-chunks

[Rollup](https://github.com/rollup/rollup) plugin to extract imported CSS files as chunks, allowing code split of CSS
stylesheets. Use [rollup-plugin-extract-bundle-tree](https://github.com/domingues/rollup-plugin-extract-bundle-tree) to
extract dependencies between JS and CSS chunks.

## Installation

```bash
npm install --save-dev rollup-plugin-css-chunks
```

## Features

- Split CSS in chunks;
- Load CSS map referenced or embedded on `sourceMappingURL`;
- Return CSS chunk public URL;

## Usage

```javascript
import css_chunk_url from './home.css';

const css_chunk_map_url = css_chunk_url + '.map';
console.log({css_chunk_url, css_chunk_map_url})
```

## Configuration

```js
// rollup.config.js
import css from 'rollup-plugin-css-chunks';

export default {
  input: 'src/main.js',
  output: {
    dir: 'public',
    format: 'esm'
  },
  plugins: [
    css({
      // just consume the CSS files
      ignore: false,
      // generate sourcemap
      sourcemap: false,
      // inject `@import` directives
      injectImports: false,
      // 'link' will rewrite the JavaScript bundle to inject link tags that load the CSS
      injectType: null,
      // name pattern for emitted secondary chunks
      chunkFileNames: '[name]-[hash].css',
      // name pattern for emitted entry chunks
      entryFileNames: '[name]-[hash].css'
    })
  ]
}
```

## License

MIT
