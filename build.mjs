import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const isWatch = process.argv.includes('--watch');

// Ensure dist directory exists
fs.mkdirSync('dist', { recursive: true });

// Build plugin sandbox code (code.ts → dist/code.js)
const codeBuildOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2020',
  format: 'iife',
};

// Build UI bundle (main.ts → inline JS for HTML)
async function buildUI() {
  const uiResult = await esbuild.build({
    entryPoints: ['src/ui/main.ts'],
    bundle: true,
    write: false,
    target: 'es2020',
    format: 'iife',
  });

  const uiJs = uiResult.outputFiles[0].text;
  const css = fs.readFileSync('src/ui/styles.css', 'utf8');
  const template = fs.readFileSync('src/ui/template.html', 'utf8');

  const html = template
    .replace('/* {{STYLES}} */', css)
    .replace('/* {{SCRIPT}} */', uiJs);

  fs.writeFileSync('dist/ui.html', html);
  console.log('✓ UI built → dist/ui.html');
}

async function build() {
  await esbuild.build(codeBuildOptions);
  console.log('✓ Code built → dist/code.js');
  await buildUI();
}

if (isWatch) {
  // Watch mode: rebuild on changes
  const ctx = await esbuild.context(codeBuildOptions);
  await ctx.watch();
  console.log('Watching code.ts...');

  // Simple file watcher for UI files
  const uiFiles = ['src/ui/main.ts', 'src/ui/ai.ts', 'src/ui/styles.css', 'src/ui/template.html'];
  for (const file of uiFiles) {
    fs.watchFile(file, { interval: 500 }, async () => {
      try {
        await buildUI();
      } catch (err) {
        console.error('UI build error:', err);
      }
    });
  }
  console.log('Watching UI files...');

  // Initial build
  await buildUI();
} else {
  await build();
  console.log('Build complete.');
}
