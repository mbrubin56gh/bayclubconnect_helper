import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['loading_script.test.mjs', 'loading_script.integration.test.mjs'],
        setupFiles: ['./vitest.setup.mjs'],
    },
});
