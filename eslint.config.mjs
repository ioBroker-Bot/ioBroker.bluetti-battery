import config from '@iobroker/eslint-config';

export default [
	{
		// Files not type-checked / not part of the adapter source
		ignores: ['.dev-server/', 'node_modules/', 'build/', 'admin/words.js', 'test/**', '*.config.mjs'],
	},
	...config,
	{
		rules: {
			// Code is TypeScript - types already document signatures. Don't force
			// JSDoc on every member.
			'jsdoc/require-jsdoc': 'off',
			'jsdoc/require-param': 'off',
			'jsdoc/require-param-description': 'off',
			'jsdoc/require-returns-description': 'off',
		},
	},
];
