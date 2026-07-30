import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.js'],
	platform: 'neutral',
	target: 'es2024',
	minify: true,
	sourcemap: false,
	// The .d.ts is hand-written in src/, beside the code it describes; copy carries
	// it into dist/ so src/ never has to ship.
	dts: false,
	copy: ['src/*.d.ts'],
	clean: true,
})
