import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.js"], languageOptions: { sourceType: "script" } },
]);

export default [
    {
        languageOptions: {
            ecmaVersion: 2021,
            globals: {
                window: 'readonly',
                document: 'readonly',
                location: 'readonly',
                history: 'readonly',
                localStorage: 'readonly',
                crypto: 'readonly',
                XMLHttpRequest: 'readonly',
            }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        }
    }
];
