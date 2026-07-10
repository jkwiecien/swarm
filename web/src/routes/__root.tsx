import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Sidebar } from '@/components/layout/sidebar.js';

function RootLayout() {
	return (
		<div className="flex min-h-screen flex-col md:flex-row bg-[#0A0A0B]">
			<Sidebar />
			<main className="flex-1 overflow-y-auto">
				<div className="p-4 md:p-8">
					<Outlet />
				</div>
			</main>
		</div>
	);
}

export const rootRoute = createRootRoute({ component: RootLayout });
