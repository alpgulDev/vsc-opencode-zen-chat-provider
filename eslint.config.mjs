import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['.context/**', 'out/**', 'node_modules/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', fetch: 'readonly' }
		}
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module'
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
