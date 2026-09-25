-- chat-images: explicit deny for direct client writes (uploads happen server-side)
DROP POLICY IF EXISTS "chat_images_no_client_insert" ON storage.objects;
CREATE POLICY "chat_images_no_client_insert"
ON storage.objects FOR INSERT TO authenticated, anon
WITH CHECK (false);

DROP POLICY IF EXISTS "chat_images_no_client_update" ON storage.objects;
CREATE POLICY "chat_images_no_client_update"
ON storage.objects FOR UPDATE TO authenticated, anon
USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "chat_images_no_client_delete" ON storage.objects;
CREATE POLICY "chat_images_no_client_delete"
ON storage.objects FOR DELETE TO authenticated, anon
USING (false);

-- daily_free_usage: explicit deny for direct client writes (server-only via security definer functions)
DROP POLICY IF EXISTS "daily_free_usage_no_client_insert" ON public.daily_free_usage;
CREATE POLICY "daily_free_usage_no_client_insert"
ON public.daily_free_usage FOR INSERT TO authenticated, anon
WITH CHECK (false);

DROP POLICY IF EXISTS "daily_free_usage_no_client_update" ON public.daily_free_usage;
CREATE POLICY "daily_free_usage_no_client_update"
ON public.daily_free_usage FOR UPDATE TO authenticated, anon
USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "daily_free_usage_no_client_delete" ON public.daily_free_usage;
CREATE POLICY "daily_free_usage_no_client_delete"
ON public.daily_free_usage FOR DELETE TO authenticated, anon
USING (false);