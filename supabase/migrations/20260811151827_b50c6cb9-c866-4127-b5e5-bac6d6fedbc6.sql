CREATE POLICY "user_roles_no_client_insert"
ON public.user_roles FOR INSERT
TO authenticated
WITH CHECK (false);

CREATE POLICY "user_roles_no_client_update"
ON public.user_roles FOR UPDATE
TO authenticated
USING (false)
WITH CHECK (false);

CREATE POLICY "user_roles_no_client_delete"
ON public.user_roles FOR DELETE
TO authenticated
USING (false);

CREATE POLICY "user_roles_no_anon_insert"
ON public.user_roles FOR INSERT
TO anon
WITH CHECK (false);

CREATE POLICY "user_roles_no_anon_update"
ON public.user_roles FOR UPDATE
TO anon
USING (false)
WITH CHECK (false);

CREATE POLICY "user_roles_no_anon_delete"
ON public.user_roles FOR DELETE
TO anon
USING (false);
