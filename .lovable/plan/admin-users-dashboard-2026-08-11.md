# Admin users dashboard

Add a simple, admin-only users dashboard so the owner can see how many people have signed up without querying the database manually.

## Goal

Create a new authenticated admin page at `/admin` that shows:
- Total signed-up users
- New sign-ups in the last 7, 30, and 90 days
- A scrollable list of users (name, email, signup date, plan if any)
- Visible only to users with the `admin` role

## Current state

- The app has a `profiles` table with `name`, `email`, `created_at`, and `id` (one row per user).
- There is no role/permission system yet.
- There is no admin page or admin link in the sidebar.
- Signed-in routes are protected by the integration-managed `_authenticated` layout.

## Proposed changes

### 1. Database: roles and admin check

Create a new migration that:
- Adds a `public.app_role` enum (`admin`, `user`).
- Creates a `public.user_roles` table (`id`, `user_id` references `auth.users`, `role`, `created_at`).
- Grants access and enables RLS.
- Adds a `public.has_role(_user_id uuid, _role app_role)` security-definer helper.
- Adds an admin policy so authenticated users can read their own roles, plus a service-role grant.
- Creates a `public.app_settings` row (or re-uses an existing mechanism) to store the first admin user ID, or documents that the initial admin will be assigned manually via backend.

### 2. Server function: admin stats

Create `src/lib/admin.functions.ts` with:
- `getAdminStats` — a `createServerFn({ method: "GET" })` that uses `requireSupabaseAuth`.
- Inside the handler, verify the caller has the `admin` role via `public.has_role`.
- Return counts and a paginated user list joined from `auth.users`/`public.profiles` and `public.subscriptions`.
- Return a clear 403 if the caller is not an admin.

### 3. Admin page

Create `src/routes/_authenticated/admin.tsx`:
- Route loader (or component query) calls `getAdminStats`.
- Renders a clean dashboard with cards for totals and a table for the user list.
- Uses existing components and Tailwind tokens (no hardcoded colors).
- Defines `head()` with a unique title and description for SEO.

### 4. Sidebar admin link

Update `src/components/layout/Sidebar.tsx`:
- Add a new client-side query to check if the current user is admin (`useAdminCheck` or inline).
- Add an "Admin" link to the account dropdown, shown only when the user is an admin.

### 5. Verification

- Run the database migration and confirm it is applied.
- Typecheck the project.
- Smoke-test the route and ensure non-admin users get a 403 / access-denied UI.
- Confirm the admin link only appears for admin users.

## Open decision

The initial admin user must be assigned directly in the database (inserting a row into `user_roles` with role `admin`). I can do this after the migration is applied. Alternatively, if you want a self-serve setup (e.g., the first signed-up user becomes admin automatically), I can add a trigger for that. Which do you prefer?
