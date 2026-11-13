-- Scheduler authorization headers must remain server-only.
REVOKE ALL ON TABLE net.http_request_queue, net._http_response FROM PUBLIC, anon, authenticated;
