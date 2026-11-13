-- Only the server Edge Function may execute the fixed SQL statements in worker/api.
-- Client requests never receive this RPC's service-role credential or submit SQL.
CREATE OR REPLACE FUNCTION public.brigade_query_batch(commands jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  command jsonb;
  statement text;
  original_statement text;
  remaining_statement text;
  parameter jsonb;
  parameters jsonb;
  replacement text;
  placeholder_pos integer;
  parameter_index integer;
  rows jsonb;
  output jsonb := '[]'::jsonb;
  is_select boolean;
  has_returning boolean;
BEGIN
  IF jsonb_typeof(commands) IS DISTINCT FROM 'array' OR jsonb_array_length(commands) < 1 OR jsonb_array_length(commands) > 25 THEN
    RAISE EXCEPTION 'Invalid database batch';
  END IF;
  FOR command IN SELECT value FROM jsonb_array_elements(commands)
  LOOP
    original_statement := command->>'sql';
    parameters := COALESCE(command->'params','[]'::jsonb);
    IF original_statement IS NULL OR length(original_statement)>16384 OR original_statement ~ ';|--|/\*' OR original_statement !~* '^\s*(SELECT|INSERT|UPDATE|DELETE)\s' OR jsonb_typeof(parameters) IS DISTINCT FROM 'array' OR jsonb_array_length(parameters)>64 THEN
      RAISE EXCEPTION 'Invalid database statement';
    END IF;
    -- Tables are schema-qualified by the adapter. Only fixed server SQL reaches this function.
    IF original_statement !~ 'brigade\.' THEN RAISE EXCEPTION 'Invalid database schema'; END IF;
    is_select := original_statement ~* '^\s*SELECT\s';
    has_returning := original_statement ~* '\mRETURNING\M';
    statement := '';
    remaining_statement := original_statement;
    parameter_index := 0;
    LOOP
      placeholder_pos := strpos(remaining_statement,'?');
      EXIT WHEN placeholder_pos=0;
      IF parameter_index>=jsonb_array_length(parameters) THEN RAISE EXCEPTION 'Missing database parameter'; END IF;
      parameter := parameters->parameter_index;
      -- quote_literal operates on a JSON scalar, never on SQL text or identifiers.
      IF jsonb_typeof(parameter)='null' THEN replacement:='NULL';
      ELSIF jsonb_typeof(parameter) IN ('string','number','boolean') THEN replacement:=quote_literal(parameter #>> '{}');
      ELSE RAISE EXCEPTION 'Invalid database parameter'; END IF;
      statement := statement||substr(remaining_statement,1,placeholder_pos-1)||replacement;
      remaining_statement := substr(remaining_statement,placeholder_pos+1);
      parameter_index:=parameter_index+1;
      -- Never scan inserted user literals (including their question marks) as SQL.
    END LOOP;
    statement:=statement||remaining_statement;
    IF parameter_index<>jsonb_array_length(parameters) THEN RAISE EXCEPTION 'Excess database parameters'; END IF;
    IF NOT is_select AND NOT has_returning THEN statement:=statement||' RETURNING 1 AS affected'; END IF;
    EXECUTE 'WITH api_rows AS ('||statement||') SELECT COALESCE(jsonb_agg(to_jsonb(api_rows)),''[]''::jsonb) FROM api_rows' INTO rows;
    output:=output||jsonb_build_array(jsonb_build_object('success',true,'results',rows,'meta',jsonb_build_object('changes',jsonb_array_length(rows))));
  END LOOP;
  RETURN output;
END
$function$;
REVOKE ALL ON FUNCTION public.brigade_query_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.brigade_query_batch(jsonb) TO service_role;
