# green-start-web

React + TypeScript + Vite frontend foundation for Green Start (omnichannel marketing platform).
Faithful port of the prototype's design system and shell — **not** a redesign.

## Stack
React 18 · TypeScript · Vite · Tailwind (tokens bound to CSS variables) · React Router 6 ·
TanStack Query (server state) · Zustand (UI/session state) · lucide-react.

## Run
```bash
npm install
npm run dev        # http://localhost:5173  (mock data, no backend needed)
npm run typecheck
npm run lint
npm run build
```

## Mock vs real (no code branches in components)
- `VITE_USE_MOCKS=true` (default) — whole app runs on in-memory mocks.
- `VITE_REAL_APIS=dashboard,customers` — route specific modules to the real NestJS API while the rest stay mocked.
- `VITE_USE_MOCKS=false` — all modules real; the Vite dev proxy sends `/api` to `VITE_API_ORIGIN`.

Auth/workspace headers, the `{success,data|error}` envelope, and `ApiError` are already wired in
`services/apiClient.ts` to match `GREEN_START_API_CONTRACT.md` — connecting the backend is a config flag, not a rewrite.

## Structure
`app/` composition (router from a single `navigation.ts`, providers, guard, layout) ·
`components/{ui,layout,feedback,charts,toast}` design system · `features/*` pages + hooks ·
`services/*` the only data access (mock/real switch) · `stores/*` Zustand · `types/` the API contract ·
`mocks/` dev seed (imported only by service mock branches) · `lib/` pure utilities · `styles/globals.css` design tokens.

Built pages: **Dashboard** (live on a typed hook) + **Login**. Every other module renders an honest placeholder.
