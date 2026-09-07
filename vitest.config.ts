import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sdk = fileURLToPath(new URL('./packages/kuro-plugin-sdk/src', import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@kuro/plugin-sdk/testing': `${sdk}/testing/index.ts`,
			'@kuro/plugin-sdk': `${sdk}/index.ts`
		}
	},
	test: {
		environment: 'node',
		include: ['packages/**/*.spec.ts', 'plugins/**/*.spec.ts'],
		expect: { requireAssertions: true }
	}
});
