REVOKE EXECUTE ON FUNCTION public.active_plan(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.active_plan(uuid, text) TO service_role;