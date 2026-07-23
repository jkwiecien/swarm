import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Matches the API server's default API_PORT (.env.docker.example). Update this if
// you've overridden API_PORT in .env — same hardcoded-target approach Cascade's own
// vite.config.ts uses for its dashboard's default port.
const API_URL = 'http://127.0.0.1:3101';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			'/trpc': {
				target: API_URL,
				changeOrigin: true,
			},
			'/health': {
				target: API_URL,
				changeOrigin: true,
			},
			'/auth': {
				target: API_URL,
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
	resolve: {
		alias: { '@': path.resolve(__dirname, './src') },
	},
});
