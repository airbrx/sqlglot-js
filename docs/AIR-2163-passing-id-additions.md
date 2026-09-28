# AIR-2163 explicit passing-ID additions

No previous accepted ID is removed; fixture population, expectations and provenance are unchanged.
These are additions for review, not a replacement baseline. COPY/PIVOT parsing and WINDOW/QUALIFY generation are independently checked against pinned Python by a strict 263-row oracle.

## corpus: 5727 → 5872 accepted passes (+145; regressions 0)

| ID | Read → write | Input |
|---|---|---|
| `00da0d53b86f91ed` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `0121bf30588afe8f` | postgres → postgres | `SELECT SUM(x) OVER a, SUM(y) OVER b FROM c WINDOW a AS (PARTITION BY d), b AS (PARTITION BY e)` |
| `01d2b6addcbe26a8` | duckdb → duckdb | `SELECT PERCENT_RANK( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `0380575962620c07` | duckdb → duckdb | `SELECT SUM(x) OVER (ORDER BY x GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t` |
| `040698a55b610de0` | bigquery → bigquery | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `0b12f4093d525a6a` | postgres → duckdb | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `0b9ffcd3eaada8b2` | snowflake → snowflake | `SELECT MODE(status) OVER (PARTITION BY region) FROM orders` |
| `0cbd2d7d0228b646` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `0f758df55e15f1d5` | redshift → bigquery | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `1533b3926f191f68` | databricks → databricks | `NTILE() OVER (ORDER BY 1)` |
| `15c76b8bec00272e` | snowflake → snowflake | `SELECT LEAD(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `16fcd75eba08684b` | snowflake → snowflake | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `16fe11e03bd606be` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)` |
| `198d0dbad5ac84fe` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT DENSE_RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `19b08357d52c384a` | snowflake → postgres | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `1adc84171dc90812` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT NTILE(4) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `1ca71b808327d41a` | postgres → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `1e62f4e3aa980609` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT NTILE(4) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `1f3e2b8c8d6f0910` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `2041c9351da504ae` | snowflake → snowflake | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `2177bbc4977a3a5a` | default → default | `SELECT ROW_NUMBER() OVER(PARTITION BY event_time + interval '00:00:01'::interval) AS foo FROM t` |
| `221cc3b2fe77b9e0` | default → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 ASC NULLS LAST) FROM t` |
| `28a19a411bb86bdf` | snowflake → spark | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `29ccbb85d04c92ce` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW)` |
| `2c26f08e66da0be7` | snowflake → snowflake | `SELECT KURTOSIS(x) OVER (PARTITION BY 1)` |
| `349f73bee3c0c75c` | duckdb → snowflake | `SELECT c, COUNT(*) FILTER (WHERE b > 0) OVER (PARTITION BY c) FROM t` |
| `35d305ffa3be087d` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `36f882ec80fbb083` | duckdb → postgres | `SELECT FIRST_VALUE(c RESPECT NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `393af7cd29dd4245` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT PERCENT_RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `407ca81710e04c15` | redshift → redshift | `SELECT LAG(x) IGNORE NULLS OVER (PARTITION BY y ORDER BY z)` |
| `40813c59dc038340` | snowflake → postgres | `SELECT COVAR_POP(y, x) OVER ()` |
| `40b45c4000db0621` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAG(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `40bd4ef21bc40805` | snowflake → snowflake | `SELECT PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY col) OVER (PARTITION BY category)` |
| `4144be11a8de03e6` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `4171b229f4ec08d8` | bigquery → bigquery | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `4278bd19a822f17e` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)` |
| `42df3ebcaef117e3` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT DENSE_RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `43493a3d5efed9f8` | snowflake → snowflake | `SELECT LAG(amount, 2) IGNORE NULLS OVER (PARTITION BY category ORDER BY seq) AS lag_offset_ignore_nulls` |
| `479ea770fd29bf3d` | snowflake → duckdb | `SELECT LEAD(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `4a7e70d5a0ee7f91` | snowflake → snowflake | `SELECT STDDEV_SAMP(x) OVER (PARTITION BY 1)` |
| `4ab094e1055e2fc7` | duckdb → bigquery | `SELECT SUM(X) OVER (ORDER BY x)` |
| `4af9d195dcfa86c7` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `4c27d6644d84a1ed` | snowflake → duckdb | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `4c7544deca260911` | default → snowflake | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `4f18c59a5d5cafeb` | snowflake → postgres | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `4ffdf4c4edef103e` | default → snowflake | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `519fb1aa5084ba56` | snowflake → snowflake | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `527e53be7e025bf9` | duckdb → duckdb | `SELECT CUME_DIST( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `53bb0ef1c8ed9289` | bigquery → spark | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `5401aaf1ac7388a8` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1) IGNORE NULLS OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `54738df3fc705f20` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `56178c12f4d4bf19` | snowflake → postgres | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `572b7dc8bbd73e04` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT FIRST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `5733b6427d47ca32` | snowflake → bigquery | `SELECT a FROM test AS t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY Z) = 1` |
| `5a86cb741bbb24ee` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT FIRST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `5b1da5dc6176b947` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `5c80f1992e5215f8` | snowflake → snowflake | `SELECT STDDEV(x) OVER (PARTITION BY 1)` |
| `632052e823e90d20` | duckdb → duckdb | `SELECT SUM(X) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `659d6b26e038ac5e` | duckdb → postgres | `SELECT FIRST_VALUE(c IGNORE NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `673fa57bc3f8fee1` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `68613eb3bdb0aaa5` | redshift → spark | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `6eb1448d0e53fc20` | snowflake → default | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `6f21160c1c4bba14` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `70d5efbd8790baa3` | duckdb → duckdb | `SELECT LAST_VALUE(x ORDER BY x IGNORE NULLS) OVER (ORDER BY x) FROM t` |
| `711855f80f9f76f6` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1 IGNORE NULLS) OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `739d56229a30ae39` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT CUME_DIST() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `74552cf22c24fd52` | redshift → hive | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `74ba5722c1a25358` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `7592673d79c988bc` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LEAD(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `76742c3392209326` | duckdb → duckdb | `SELECT FIRST_VALUE(c IGNORE NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `7853dbec50a97012` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `7c84238d7eee15bf` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) FROM FIRST IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `7fca4b1d2c819e1a` | snowflake → default | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `814091cf37fbec8c` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT ROW_NUMBER() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `8186f5e7e77847b4` | duckdb → duckdb | `SELECT schema_name, function_name, ROW_NUMBER() OVER my_window AS function_rank FROM DUCKDB_FUNCTIONS() WINDOW my_window AS (PARTITION BY schema_name ORDER BY function_name) QUALIFY ROW_NUMBER() OVER my_window < 3` |
| `81b2f8bf260afdb2` | default → postgres | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `83c44aba8d8a183f` | snowflake → snowflake | `SELECT COVAR_POP(y, x) OVER ()` |
| `858e064ba4956c9c` | bigquery → databricks | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `8602d1b8907dcfab` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LEAD(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `87b8f65acc48db5e` | bigquery → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 ASC) FROM t` |
| `8935ab38d950b4bf` | postgres → postgres | `SELECT SUM(x) OVER (PARTITION BY a ORDER BY d ROWS 1 PRECEDING)` |
| `8b5d72372f8b322e` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP)` |
| `8f16400a02438cb9` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT PERCENT_RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `8f9407a5e5f70cb0` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAG(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `8fd3c0eb59f0deac` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `93801031eda37ed0` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP)` |
| `949fbee14647ba0a` | snowflake → snowflake | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `97ac8ec768d74766` | bigquery → snowflake | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `97bdf29ee2bd9da1` | default → duckdb | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9b04d3d82975cea0` | default → duckdb | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9be4bb983de03dae` | duckdb → duckdb | `SELECT NTILE(1 ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `9c64d48163cce3e9` | default → postgres | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9c6cf96f47c5d53d` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT ROW_NUMBER() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `9f1a774c6f0d85ef` | snowflake → snowflake | `SELECT a FROM test AS t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY Z) = 1` |
| `9fcb1f82158810b8` | snowflake → duckdb | `SELECT LAG(amount) OVER (ORDER BY seq) AS basic_lag` |
| `9ff6b98fe3dda540` | snowflake → bigquery | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `a179afa771dccdf8` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `a5d44eac6b0aec1b` | duckdb → duckdb | `SELECT SUM(X) OVER (ORDER BY x)` |
| `a8f046ef301cc041` | postgres → postgres | `select count() OVER(partition by a order by a range offset preceding exclude current row)` |
| `a9b0eedcda2a77c1` | redshift → redshift | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `aa6d814c1bbf2c63` | postgres → postgres | `SELECT SUM(x) OVER (PARTITION BY y ORDER BY interval ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - SUM(x) OVER (PARTITION BY y ORDER BY interval ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total` |
| `acd818b31f2e61f0` | hive → hive | `SELECT ROW() OVER (DISTRIBUTE BY x SORT BY y)` |
| `aed849447fbd3505` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT CUME_DIST() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `b13d0d558de23208` | snowflake → default | `SELECT COVAR_POP(y, x) OVER ()` |
| `b1ef12cacca4cc2e` | postgres → duckdb | `SELECT CORR(a, b) FILTER(WHERE c > 0) OVER (PARTITION BY d)` |
| `b3a8c8a91c02744a` | redshift → databricks | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `b897616e6b80382b` | duckdb → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `bcfc1d1569d710cd` | snowflake → databricks | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `c066acec1e6454c0` | snowflake → duckdb | `SELECT LAG(amount, 2) IGNORE NULLS OVER (PARTITION BY category ORDER BY seq) AS lag_offset_ignore_nulls` |
| `c52e5de83c3dc158` | snowflake → duckdb | `SELECT COVAR_POP(y, x) OVER ()` |
| `c7e4e384b3f3e631` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1) OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `c925d70c2c66a08a` | snowflake → snowflake | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `d0bf41a28ae82157` | postgres → postgres | `LAST_VALUE("col1") OVER (ORDER BY "col2" RANGE BETWEEN INTERVAL '1 DAY' PRECEDING AND '1 month' FOLLOWING)` |
| `d0ca215c888159e5` | default → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 DESC NULLS FIRST) FROM t` |
| `d20acb2c96e4fee1` | duckdb → duckdb | `SELECT c, COUNT(*) FILTER (WHERE b > 0) OVER (PARTITION BY c) FROM t` |
| `d466906359c6ee55` | duckdb → bigquery | `SELECT SUM(X) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `d4c2c3a7ecf60852` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `d58c39c6b53f85ff` | snowflake → snowflake | `SELECT a FROM test pivot` |
| `d5f761002111af68` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `d6546d5da4fbc44b` | bigquery → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 DESC) FROM t` |
| `d79df99f40c7bfe5` | bigquery → duckdb | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `d81cb24e2f774e7d` | snowflake → snowflake | `SELECT LAG(amount) OVER (ORDER BY seq) AS basic_lag` |
| `d924f93102afc7a7` | snowflake → snowflake | `SELECT STDDEV_POP(x) OVER (PARTITION BY 1)` |
| `dcc06f6d9d95b0aa` | default → tsql | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `dd29fb7377e386b7` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `dd4f788965108f49` | snowflake → default | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `df4caed7b0cc7a14` | bigquery → tsql | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `df93af8dab9887c9` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `e19b230043c4f6e6` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW)` |
| `e51205eb00d42f3e` | postgres → postgres | `SELECT CORR(a, b) FILTER(WHERE c > 0) OVER (PARTITION BY d)` |
| `e55d45f231549329` | snowflake → hive | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `e6e1188715dd76c4` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `e76fd9ba66fa9167` | duckdb → duckdb | `SELECT RANK( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `e9466fa461fff530` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `ec246fcb32265e3a` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `ec9749a7dcbf9a65` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `f28ad9cdddff5d32` | tsql → tsql | `SELECT DISTINCT DepartmentName, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY BaseRate) OVER (PARTITION BY DepartmentName) AS MedianCont FROM dbo.DimEmployee` |
| `f36b66798c31d881` | snowflake → snowflake | `SELECT a FROM test unpivot` |
| `f3a3d29a4e4634c9` | bigquery → postgres | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `f53d483b46e62429` | redshift → redshift | `SELECT LAG(x IGNORE NULLS) OVER (PARTITION BY y ORDER BY z)` |
| `f597be4a608a4e1d` | postgres → postgres | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `fa18eeb2400b3aa3` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `fa2fa751763c79a9` | postgres → snowflake | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `fc0def8bc0963182` | postgres → snowflake | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `ff22173756c5ed60` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |

## parse: 10279 → 10337 accepted passes (+58; regressions 0)

| ID | Read → write | Input |
|---|---|---|
| `013ec69584f5a2f4` | databricks → databricks | `COPY INTO target FROM &#96;s3://link&#96; FILEFORMAT = AVRO VALIDATE = ALL FILES = ('file1', 'file2') FORMAT_OPTIONS ('opt1'='true', 'opt2'='test') COPY_OPTIONS ('mergeSchema'='true')` |
| `01740795433e5f34` | duckdb → duckdb | `SELECT * FROM t PIVOT(FIRST(t) AS t, FOR quarter IN ('Q1', 'Q2'))` |
| `06ab8d764a37f261` | bigquery → bigquery | `SELECT * FROM (SELECT * FROM &#96;t&#96;) AS a UNPIVOT((c) FOR c_name IN (v1, v2))` |
| `0a7f92d0199efb61` | databricks → databricks | `SELECT * FROM sales UNPIVOT INCLUDE NULLS (sales FOR quarter IN (q1 AS &#96;Jan-Mar&#96;))` |
| `0eac4468bc4ffdbd` | snowflake → spark | `SELECT piv.Q1 FROM produce PIVOT(SUM(sales) FOR quarter IN ('Q1', 'Q2')) piv` |
| `18c951e46494f06a` | bigquery → bigquery | `SELECT * FROM Produce UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((Q1, Q2) AS 'semester_1', (Q3, Q4) AS 'semester_2'))` |
| `1ff60b62d7611cfd` | snowflake → snowflake | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) FOR quarter IN ('2023_Q1', '2023_Q2', '2023_Q3', '2023_Q4', '2024_Q1') DEFAULT ON NULL (0)) ORDER BY empid` |
| `237b9abf1ed9c901` | snowflake → snowflake | `COPY INTO load1 FROM @%load1/data1/ CREDENTIALS = (AWS_KEY_ID='id' AWS_SECRET_KEY='key' AWS_TOKEN='token') FILES = ('test1.csv', 'test2.csv') FORCE = TRUE` |
| `30463ca0cfa35dfa` | spark → bigquery | `SELECT * FROM Produce UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((Q1, Q2) AS semester_1, (Q3, Q4) AS semester_2))` |
| `310cba02ca2b2dc4` | bigquery → spark | `SELECT * FROM Produce UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((Q1, Q2) AS 1, (Q3, Q4) AS 2))` |
| `346e269fc9b8bd69` | bigquery → bigquery | `SELECT * FROM Produce UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((Q1, Q2) AS 1, (Q3, Q4) AS 2))` |
| `3c991e0db68c4fdb` | redshift → redshift | `COPY test_staging_tbl FROM 's3://your/bucket/prefix/here' IAM_ROLE default FORMAT AS AVRO 'auto'` |
| `3e934fb91e542097` | snowflake → snowflake | `COPY INTO 's3://example/data.csv'     FROM EXTRA.EXAMPLE.TABLE     STORAGE_INTEGRATION = S3_INTEGRATION     FILE_FORMAT = (TYPE=CSV COMPRESSION=NONE NULL_IF=('') FIELD_OPTIONALLY_ENCLOSED_BY='"')     HEADER = TRUE     OVERWRITE = TRUE     SINGLE = TRUE             ` |
| `483ecf7ddc6ba3e7` | postgres → postgres | `COPY tbl (col1, col2) FROM 'file' WITH (FORMAT format, HEADER MATCH, FREEZE TRUE)` |
| `4ce85b7b56535e85` | redshift → redshift | `COPY test_staging_tbl FROM 's3://your/bucket/prefix/here' IAM_ROLE default FORMAT AS JSON 's3://jsonpaths_file'` |
| `5692a74d49a4b6f5` | snowflake → snowflake | `COPY INTO mytable FROM 'azure://myaccount.blob.core.windows.net/mycontainer/data/files' CREDENTIALS = (AZURE_SAS_TOKEN='token') ENCRYPTION = (TYPE='AZURE_CSE' MASTER_KEY='kPx...') FILE_FORMAT = (FORMAT_NAME=my_csv_format)` |
| `5ae4960bae60db9a` | snowflake → snowflake | `SELECT * FROM table AT (TIMESTAMP => '2024-07-24') UNPIVOT(a FOR b IN (c)) AS pivot_table` |
| `5c8d8c812e54c4e6` | snowflake → snowflake | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) FOR quarter IN (ANY ORDER BY quarter)) ORDER BY empid` |
| `5e0aab6b0b9daddb` | snowflake → spark | `SELECT * FROM produce PIVOT (SUM(produce.sales) FOR produce.quarter IN ('Q1', 'Q2'))` |
| `5ed6679415ea6aa4` | postgres → postgres | `COPY tbl (col1, col2) TO 'file' WITH (FORMAT format, HEADER MATCH, FREEZE TRUE)` |
| `68cba6ad437de5b5` | snowflake → duckdb | `SELECT * FROM produce PIVOT(SUM(produce.sales) FOR produce.quarter IN ('Q1', 'Q2'))` |
| `697d1e0fd16e721b` | snowflake → snowflake | `COPY INTO @my_stage/result/data FROM (SELECT * FROM orderstiny) FILE_FORMAT = (TYPE='csv')` |
| `6eb5a993af789dc1` | snowflake → snowflake | `COPY INTO MY_DATABASE.MY_SCHEMA.MY_TABLE FROM @MY_DATABASE.MY_SCHEMA.MY_STAGE/my_path FILE_FORMAT = (FORMAT_NAME=MY_DATABASE.MY_SCHEMA.MY_FILE_FORMAT)` |
| `74ab372e6c57e241` | snowflake → snowflake | `SELECT * FROM t UNPIVOT(a FOR b IN (c, d)) UNPIVOT(e FOR f IN (g, h))` |
| `75e307c218f88ea2` | spark → databricks | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) AS amount, 'dummy' AS bar FOR quarter IN ('2023_Q1'))` |
| `75f0e0c03bc7c6dc` | duckdb → duckdb | `COPY (SELECT 42 AS a, 'hello' AS b) TO 'query.json' WITH (FORMAT JSON, ARRAY TRUE)` |
| `80ce4b07928d6e6c` | spark → spark | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) amount, 'dummy' bar FOR quarter IN ('2023_Q1'))` |
| `839695d681e355cf` | snowflake → snowflake | `COPY INTO mytable FILE_FORMAT = (TYPE='csv')` |
| `88ef17d3cfa72a33` | tsql → tsql | `COPY INTO test_1 FROM 'path' WITH (FORMAT_NAME = test, FILE_TYPE = 'CSV', CREDENTIAL = (IDENTITY='Shared Access Signature', SECRET='token'), FIELDTERMINATOR = ';', ROWTERMINATOR = '0X0A', ENCODING = 'UTF8', DATEFORMAT = 'ymd', MAXERRORS = 10, ERRORFILE = 'errorsfolder', IDENTITY_INSERT = 'ON')` |
| `8f781bacf81e02d3` | bigquery → spark | `SELECT * FROM produce AS p PIVOT(SUM(p.sales) AS sales FOR p.quarter IN ('Q1' AS Q1, 'Q2' AS Q1))` |
| `9300651c2cf2000a` | bigquery → bigquery | `SELECT * FROM (SELECT a, b, c FROM test) PIVOT(SUM(b) d, COUNT(*) e FOR c IN ('x', 'y'))` |
| `9a9e5f02e8d9a2f0` | duckdb → duckdb | `COPY (SELECT * FROM "input.parquet" USING SAMPLE RESERVOIR (5000 ROWS)) TO 'output.parquet' WITH (FORMAT PARQUET, KV_METADATA {'origin': 'Dagster', 'dagster_run_id': '98c85a11-d05c-4935-bfa2-198214c2204'})` |
| `a2e90dc2b1e9d813` | duckdb → duckdb | `SELECT * FROM produce PIVOT(SUM(sales) FOR quarter IN ('Q1', 'Q2'))` |
| `ac8cbccfdc51b9f6` | duckdb → duckdb | `COPY lineitem FROM 'lineitem.ndjson' WITH (FORMAT JSON, DELIMITER ',', AUTO_DETECT TRUE, COMPRESSION SNAPPY, CODEC ZSTD, FORCE_NOT_NULL (col1, col2))` |
| `ade0a2a0e9c98b2d` | snowflake → snowflake | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) FOR quarter IN (SELECT DISTINCT quarter FROM ad_campaign_types_by_quarter WHERE television = TRUE ORDER BY quarter)) ORDER BY empid` |
| `b152b8b51d1a92df` | snowflake → snowflake | `SELECT * FROM t PIVOT(SUM(v) FOR c IN ('a' AS a)) UNPIVOT(x FOR y IN (a))` |
| `b27227f7430038af` | snowflake → snowflake | `SELECT a FROM test PIVOT(SUM(x) FOR y IN ('z', 'q')) AS x TABLESAMPLE BERNOULLI (0.1)` |
| `b3665fa85f8ba0b4` | snowflake → spark | `SELECT piv.Q1 FROM (SELECT * FROM produce) PIVOT(SUM(sales) FOR quarter IN ('Q1', 'Q2')) piv` |
| `b790ddee3d50ab7c` | snowflake → snowflake | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) FOR quarter IN (ANY)) ORDER BY empid` |
| `bee7c9e46c9ecc3d` | postgres → postgres | `COPY (SELECT * FROM t) TO 'file' WITH (FORMAT format, HEADER MATCH, FREEZE TRUE)` |
| `c50fe0f8c8b78f71` | snowflake → snowflake | `COPY INTO 's3://example/data.csv'     FROM EXTRA.EXAMPLE.TABLE     CREDENTIALS = ()     FILE_FORMAT = (TYPE = CSV COMPRESSION = NONE NULL_IF = ('') FIELD_OPTIONALLY_ENCLOSED_BY = '"')     HEADER = TRUE     OVERWRITE = TRUE     SINGLE = TRUE             ` |
| `cc9fe8892a562a8c` | databricks → spark | `SELECT * FROM quarterly_sales PIVOT(SUM(amount) amount, 'dummy' bar FOR quarter IN ('2023_Q1'))` |
| `d15e9d835ae1cb48` | snowflake → snowflake | `COPY INTO mytable (col1, col2) FROM 's3://mybucket/data/files' STORAGE_INTEGRATION = "storage" ENCRYPTION = (TYPE='NONE' MASTER_KEY='key') FILES = ('file1', 'file2') PATTERN = 'pattern' FILE_FORMAT = (FORMAT_NAME=my_csv_format NULL_IF=('')) PARSE_HEADER = TRUE` |
| `d193df5d5f7fa74e` | duckdb → duckdb | `SELECT * FROM cities PIVOT(SUM(population) FOR year IN (2000, 2010, 2020) GROUP BY country)` |
| `d58c39c6b53f85ff` | snowflake → snowflake | `SELECT a FROM test pivot` |
| `d7c68636d18e85c8` | bigquery → bigquery | `SELECT * FROM q UNPIVOT(values FOR quarter IN (b, c))` |
| `da8f71d72752583e` | bigquery → spark | `SELECT * FROM Produce UNPIVOT((first_half_sales, second_half_sales) FOR semesters IN ((Q1, Q2) AS 'semester_1', (Q3, Q4) AS 'semester_2'))` |
| `dcc88c76ec6789a5` | bigquery → bigquery | `SELECT cars, apples FROM some_table PIVOT(SUM(total_counts) FOR products IN ('general.cars' AS cars, 'food.apples' AS apples))` |
| `dfa41a85c71b6b77` | duckdb → duckdb | `COPY lineitem (l_orderkey) TO 'orderkey.tbl' WITH (DELIMITER '\|')` |
| `e323555f3e3e489b` | snowflake → snowflake | `COPY INTO test (c1) FROM (SELECT $1.c1 FROM @mystage)` |
| `e4575873bde9714e` | snowflake → default | `COPY INTO 's3://example/data.csv'     FROM EXTRA.EXAMPLE.TABLE     CREDENTIALS = ()     FILE_FORMAT = (TYPE = CSV COMPRESSION = NONE NULL_IF = ('') FIELD_OPTIONALLY_ENCLOSED_BY = '"')     HEADER = TRUE     OVERWRITE = TRUE     SINGLE = TRUE             ` |
| `e7197f3ace43ea51` | duckdb → duckdb | `SELECT * FROM t PIVOT(SUM(y) FOR foo IN y_enum)` |
| `e9704fa33d052fc0` | snowflake → default | `COPY INTO 's3://example/data.csv'     FROM EXTRA.EXAMPLE.TABLE     STORAGE_INTEGRATION = S3_INTEGRATION     FILE_FORMAT = (TYPE=CSV COMPRESSION=NONE NULL_IF=('') FIELD_OPTIONALLY_ENCLOSED_BY='"')     HEADER = TRUE     OVERWRITE = TRUE     SINGLE = TRUE             ` |
| `ead69bdfaa64c99b` | snowflake → snowflake | `COPY INTO temp FROM @random_stage/path/ FILE_FORMAT = (TYPE=CSV FIELD_DELIMITER='\|' NULL_IF=('str1', 'str2') FIELD_OPTIONALLY_ENCLOSED_BY='"' TIMESTAMP_FORMAT='TZHTZM YYYY-MM-DD HH24:MI:SS.FF9' DATE_FORMAT='TZHTZM YYYY-MM-DD HH24:MI:SS.FF9' BINARY_FORMAT=BASE64) VALIDATION_MODE = 'RETURN_3_ROWS'` |
| `f0450ce77896cabb` | redshift → redshift | `COPY customer FROM 's3://mybucket/mydata' CREDENTIALS 'aws_iam_role=arn:aws:iam::<aws-account-id>:role/<role-name>;master_symmetric_key=<root-key>' emptyasnull blanksasnull timeformat 'YYYY-MM-DD HH:MI:SS'` |
| `f36b66798c31d881` | snowflake → snowflake | `SELECT a FROM test unpivot` |
| `f66b7fcbed559cda` | redshift → redshift | `COPY customer FROM 's3://mybucket/customer' IAM_ROLE 'arn:aws:iam::0123456789012:role/MyRedshiftRole' REGION 'us-east-1' FORMAT orc` |
| `f96c0df01c683aaf` | databricks → databricks | `SELECT * FROM sales UNPIVOT EXCLUDE NULLS (sales FOR quarter IN (q1 AS &#96;Jan-Mar&#96;))` |

## generate: 6969 → 7126 accepted passes (+157; regressions 0)

| ID | Read → write | Input |
|---|---|---|
| `00da0d53b86f91ed` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `0121bf30588afe8f` | postgres → postgres | `SELECT SUM(x) OVER a, SUM(y) OVER b FROM c WINDOW a AS (PARTITION BY d), b AS (PARTITION BY e)` |
| `01d2b6addcbe26a8` | duckdb → duckdb | `SELECT PERCENT_RANK( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `0380575962620c07` | duckdb → duckdb | `SELECT SUM(x) OVER (ORDER BY x GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t` |
| `040698a55b610de0` | bigquery → bigquery | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `0b12f4093d525a6a` | postgres → duckdb | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `0b9ffcd3eaada8b2` | snowflake → snowflake | `SELECT MODE(status) OVER (PARTITION BY region) FROM orders` |
| `0cbd2d7d0228b646` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `0f758df55e15f1d5` | redshift → bigquery | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `1533b3926f191f68` | databricks → databricks | `NTILE() OVER (ORDER BY 1)` |
| `15c76b8bec00272e` | snowflake → snowflake | `SELECT LEAD(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `16fcd75eba08684b` | snowflake → snowflake | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `16fe11e03bd606be` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)` |
| `198d0dbad5ac84fe` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT DENSE_RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `19b08357d52c384a` | snowflake → postgres | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `1adc84171dc90812` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT NTILE(4) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `1ca71b808327d41a` | postgres → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `1e62f4e3aa980609` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT NTILE(4) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `1f3e2b8c8d6f0910` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `2041c9351da504ae` | snowflake → snowflake | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `2177bbc4977a3a5a` | default → default | `SELECT ROW_NUMBER() OVER(PARTITION BY event_time + interval '00:00:01'::interval) AS foo FROM t` |
| `221cc3b2fe77b9e0` | default → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 ASC NULLS LAST) FROM t` |
| `28a19a411bb86bdf` | snowflake → spark | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `29ccbb85d04c92ce` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW)` |
| `2c26f08e66da0be7` | snowflake → snowflake | `SELECT KURTOSIS(x) OVER (PARTITION BY 1)` |
| `349f73bee3c0c75c` | duckdb → snowflake | `SELECT c, COUNT(*) FILTER (WHERE b > 0) OVER (PARTITION BY c) FROM t` |
| `35d305ffa3be087d` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `36f882ec80fbb083` | duckdb → postgres | `SELECT FIRST_VALUE(c RESPECT NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `393af7cd29dd4245` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT PERCENT_RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `407ca81710e04c15` | redshift → redshift | `SELECT LAG(x) IGNORE NULLS OVER (PARTITION BY y ORDER BY z)` |
| `40813c59dc038340` | snowflake → postgres | `SELECT COVAR_POP(y, x) OVER ()` |
| `40b45c4000db0621` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAG(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `40bd4ef21bc40805` | snowflake → snowflake | `SELECT PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY col) OVER (PARTITION BY category)` |
| `4144be11a8de03e6` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT RANK() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `4171b229f4ec08d8` | bigquery → bigquery | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `4278bd19a822f17e` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)` |
| `42df3ebcaef117e3` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT DENSE_RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `43493a3d5efed9f8` | snowflake → snowflake | `SELECT LAG(amount, 2) IGNORE NULLS OVER (PARTITION BY category ORDER BY seq) AS lag_offset_ignore_nulls` |
| `479ea770fd29bf3d` | snowflake → duckdb | `SELECT LEAD(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `4878de2a53e39fd0` | exasol → databricks | `SELECT city, COUNT(*) OVER () FROM dealer GROUP BY ALL` |
| `4a7e70d5a0ee7f91` | snowflake → snowflake | `SELECT STDDEV_SAMP(x) OVER (PARTITION BY 1)` |
| `4ab094e1055e2fc7` | duckdb → bigquery | `SELECT SUM(X) OVER (ORDER BY x)` |
| `4af9d195dcfa86c7` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `4c27d6644d84a1ed` | snowflake → duckdb | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `4c7544deca260911` | default → snowflake | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `4f18c59a5d5cafeb` | snowflake → postgres | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `4ffdf4c4edef103e` | default → snowflake | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `519fb1aa5084ba56` | snowflake → snowflake | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `527e53be7e025bf9` | duckdb → duckdb | `SELECT CUME_DIST( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `53bb0ef1c8ed9289` | bigquery → spark | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `5401aaf1ac7388a8` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1) IGNORE NULLS OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `54738df3fc705f20` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `56178c12f4d4bf19` | snowflake → postgres | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `572b7dc8bbd73e04` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT FIRST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `5733b6427d47ca32` | snowflake → bigquery | `SELECT a FROM test AS t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY Z) = 1` |
| `5a86cb741bbb24ee` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT FIRST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `5b1da5dc6176b947` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `5c80f1992e5215f8` | snowflake → snowflake | `SELECT STDDEV(x) OVER (PARTITION BY 1)` |
| `632052e823e90d20` | duckdb → duckdb | `SELECT SUM(X) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `659d6b26e038ac5e` | duckdb → postgres | `SELECT FIRST_VALUE(c IGNORE NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `65e10fc36079c653` | exasol → spark | `SELECT a, b, RANK(b) OVER (ORDER BY b) FROM (VALUES ('A1', 2), ('A1', 1), ('A2', 3), ('A1', 1)) AS tab(a, b)` |
| `673fa57bc3f8fee1` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `68613eb3bdb0aaa5` | redshift → spark | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `6eb1448d0e53fc20` | snowflake → default | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `6f21160c1c4bba14` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `70d5efbd8790baa3` | duckdb → duckdb | `SELECT LAST_VALUE(x ORDER BY x IGNORE NULLS) OVER (ORDER BY x) FROM t` |
| `711855f80f9f76f6` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1 IGNORE NULLS) OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `739d56229a30ae39` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT CUME_DIST() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `74552cf22c24fd52` | redshift → hive | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `74ba5722c1a25358` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `7592673d79c988bc` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LEAD(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `76742c3392209326` | duckdb → duckdb | `SELECT FIRST_VALUE(c IGNORE NULLS) OVER (PARTITION BY gb ORDER BY ob) FROM t` |
| `7853dbec50a97012` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `7c84238d7eee15bf` | snowflake → snowflake | `SELECT NTH_VALUE(is_deleted, 2) FROM FIRST IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `7fca4b1d2c819e1a` | snowflake → default | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `814091cf37fbec8c` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT ROW_NUMBER() OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `8186f5e7e77847b4` | duckdb → duckdb | `SELECT schema_name, function_name, ROW_NUMBER() OVER my_window AS function_rank FROM DUCKDB_FUNCTIONS() WINDOW my_window AS (PARTITION BY schema_name ORDER BY function_name) QUALIFY ROW_NUMBER() OVER my_window < 3` |
| `81b2f8bf260afdb2` | default → postgres | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `83c44aba8d8a183f` | snowflake → snowflake | `SELECT COVAR_POP(y, x) OVER ()` |
| `847b366683c275ef` | default → default | `SELECT 'foo1' AS item1, 2 AS item2 UNION ALL SELECT 'foo2' AS item1, 5 AS item2 \|> EXTEND SUM(item2) OVER() AS item2_sum` |
| `858e064ba4956c9c` | bigquery → databricks | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `8602d1b8907dcfab` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LEAD(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST) FROM t` |
| `87b8f65acc48db5e` | bigquery → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 ASC) FROM t` |
| `88904d222cd4f722` | default → default | `FROM (SELECT 'foo1' AS item1, 2 AS item2 UNION ALL SELECT 'foo2' AS item1, 5 AS item2) \|> EXTEND SUM(item2) OVER() AS item2_sum` |
| `8935ab38d950b4bf` | postgres → postgres | `SELECT SUM(x) OVER (PARTITION BY a ORDER BY d ROWS 1 PRECEDING)` |
| `8b5d72372f8b322e` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP)` |
| `8f16400a02438cb9` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT PERCENT_RANK() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `8f9407a5e5f70cb0` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAG(col1) OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `8fd3c0eb59f0deac` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `90df8933cf22000b` | mysql → postgres | `SELECT FIRST_VALUE(col1) OVER (ORDER BY col2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM table1` |
| `91458f300fd56f68` | exasol → databricks | `SELECT a, b, DENSE_RANK(b) OVER (ORDER BY b) FROM (VALUES ('A1', 2), ('A1', 1), ('A2', 3), ('A1', 1)) AS tab(a, b)` |
| `93801031eda37ed0` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE GROUP)` |
| `949fbee14647ba0a` | snowflake → snowflake | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `97ac8ec768d74766` | bigquery → snowflake | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `97bdf29ee2bd9da1` | default → duckdb | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9b04d3d82975cea0` | default → duckdb | `SELECT "user id", some_id, 1 as other_id, 2 as "2 nd id" FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9be4bb983de03dae` | duckdb → duckdb | `SELECT NTILE(1 ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `9c64d48163cce3e9` | default → postgres | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `9c6cf96f47c5d53d` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT ROW_NUMBER() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `9f1a774c6f0d85ef` | snowflake → snowflake | `SELECT a FROM test AS t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY Z) = 1` |
| `9fcb1f82158810b8` | snowflake → duckdb | `SELECT LAG(amount) OVER (ORDER BY seq) AS basic_lag` |
| `9ff6b98fe3dda540` | snowflake → bigquery | `SELECT a FROM test WHERE a = 1 GROUP BY a HAVING a = 2 QUALIFY z ORDER BY a LIMIT 10` |
| `a179afa771dccdf8` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `a5d44eac6b0aec1b` | duckdb → duckdb | `SELECT SUM(X) OVER (ORDER BY x)` |
| `a8f046ef301cc041` | postgres → postgres | `select count() OVER(partition by a order by a range offset preceding exclude current row)` |
| `a9b0eedcda2a77c1` | redshift → redshift | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `aa6d814c1bbf2c63` | postgres → postgres | `SELECT SUM(x) OVER (PARTITION BY y ORDER BY interval ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - SUM(x) OVER (PARTITION BY y ORDER BY interval ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total` |
| `acd818b31f2e61f0` | hive → hive | `SELECT ROW() OVER (DISTRIBUTE BY x SORT BY y)` |
| `aed849447fbd3505` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT CUME_DIST() OVER (PARTITION BY id ORDER BY col1 ASC NULLS LAST) FROM t` |
| `afe2af33da6c6cd7` | exasol → databricks | `SELECT a, b, RANK(b) OVER (ORDER BY b) FROM (VALUES ('A1', 2), ('A1', 1), ('A2', 3), ('A1', 1)) AS tab(a, b)` |
| `b13d0d558de23208` | snowflake → default | `SELECT COVAR_POP(y, x) OVER ()` |
| `b1ef12cacca4cc2e` | postgres → duckdb | `SELECT CORR(a, b) FILTER(WHERE c > 0) OVER (PARTITION BY d)` |
| `b3a8c8a91c02744a` | redshift → databricks | `SELECT DISTINCT ON (a) a, b FROM x ORDER BY c DESC` |
| `b5779f86c560a658` | bigquery → bigquery | `SELECT ROW() OVER (y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM x WINDOW y AS (PARTITION BY CATEGORY)` |
| `b897616e6b80382b` | duckdb → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `bcfc1d1569d710cd` | snowflake → databricks | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `bfcd5392d83e299d` | oracle → snowflake | `SELECT NTH_VALUE(x, 2) FROM LAST OVER (ORDER BY y) AS c FROM t` |
| `c066acec1e6454c0` | snowflake → duckdb | `SELECT LAG(amount, 2) IGNORE NULLS OVER (PARTITION BY category ORDER BY seq) AS lag_offset_ignore_nulls` |
| `c3422c2d1b9d0ef7` | mysql → postgres | `SELECT FIRST_VALUE(col1) RESPECT NULLS OVER (ORDER BY col2) FROM table1` |
| `c52e5de83c3dc158` | snowflake → duckdb | `SELECT COVAR_POP(y, x) OVER ()` |
| `c7e4e384b3f3e631` | snowflake → snowflake | `SELECT FIRST_VALUE(TABLE1.COLUMN1) OVER (PARTITION BY RANDOM_COLUMN1, RANDOM_COLUMN2 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS MY_ALIAS FROM TABLE1` |
| `c925d70c2c66a08a` | snowflake → snowflake | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `d0bf41a28ae82157` | postgres → postgres | `LAST_VALUE("col1") OVER (ORDER BY "col2" RANGE BETWEEN INTERVAL '1 DAY' PRECEDING AND '1 month' FOLLOWING)` |
| `d0ca215c888159e5` | default → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 DESC NULLS FIRST) FROM t` |
| `d20acb2c96e4fee1` | duckdb → duckdb | `SELECT c, COUNT(*) FILTER (WHERE b > 0) OVER (PARTITION BY c) FROM t` |
| `d466906359c6ee55` | duckdb → bigquery | `SELECT SUM(X) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `d4c2c3a7ecf60852` | default → postgres | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)` |
| `d5f761002111af68` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `d6546d5da4fbc44b` | bigquery → bigquery | `SELECT SUM(f1) OVER (ORDER BY f2 DESC) FROM t` |
| `d79df99f40c7bfe5` | bigquery → duckdb | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `d81cb24e2f774e7d` | snowflake → snowflake | `SELECT LAG(amount) OVER (ORDER BY seq) AS basic_lag` |
| `d924f93102afc7a7` | snowflake → snowflake | `SELECT STDDEV_POP(x) OVER (PARTITION BY 1)` |
| `dcc06f6d9d95b0aa` | default → tsql | `SELECT * FROM t QUALIFY COUNT(*) OVER () > 1` |
| `dd29fb7377e386b7` | snowflake → snowflake | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `dd4f788965108f49` | snowflake → default | `SELECT COVAR_SAMP(y, x) OVER ()` |
| `dda28d38b899bddb` | sqlite → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `df299f35774e021d` | oracle → default | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS)` |
| `df4caed7b0cc7a14` | bigquery → tsql | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `df93af8dab9887c9` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `e19b230043c4f6e6` | default → duckdb | `SELECT SUM(X) OVER (PARTITION BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW)` |
| `e51205eb00d42f3e` | postgres → postgres | `SELECT CORR(a, b) FILTER(WHERE c > 0) OVER (PARTITION BY d)` |
| `e55d45f231549329` | snowflake → hive | `SELECT i, p, o FROM qt QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY o) = 1` |
| `e6e1188715dd76c4` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `e76fd9ba66fa9167` | duckdb → duckdb | `SELECT RANK( ORDER BY foo) OVER (ORDER BY 1) FROM (SELECT 1 AS foo)` |
| `e9466fa461fff530` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
| `ec246fcb32265e3a` | snowflake → snowflake | `SELECT LAST_VALUE(is_deleted) OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `ec9749a7dcbf9a65` | snowflake → duckdb | `SELECT LAST_VALUE(is_deleted) IGNORE NULLS OVER (PARTITION BY id) AS nth_is_deleted FROM my_table` |
| `f28ad9cdddff5d32` | tsql → tsql | `SELECT DISTINCT DepartmentName, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY BaseRate) OVER (PARTITION BY DepartmentName) AS MedianCont FROM dbo.DimEmployee` |
| `f37f8011926b5d6f` | exasol → spark | `SELECT a, b, DENSE_RANK(b) OVER (ORDER BY b) FROM (VALUES ('A1', 2), ('A1', 1), ('A2', 3), ('A1', 1)) AS tab(a, b)` |
| `f3a3d29a4e4634c9` | bigquery → postgres | `SELECT purchases, LAST_VALUE(item) OVER item_window AS most_popular FROM Produce WINDOW item_window AS (PARTITION BY purchases ORDER BY purchases ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING)` |
| `f53d483b46e62429` | redshift → redshift | `SELECT LAG(x IGNORE NULLS) OVER (PARTITION BY y ORDER BY z)` |
| `f597be4a608a4e1d` | postgres → postgres | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `f68ca95c47db999d` | bigquery → bigquery | `SELECT item, purchases, LAST_VALUE(item) OVER (item_window ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS most_popular FROM Produce WINDOW item_window AS (ORDER BY purchases)` |
| `fa18eeb2400b3aa3` | bigquery → bigquery | `WITH t AS (SELECT 1 AS id, 2 AS col1) SELECT LAST_VALUE(col1) OVER (PARTITION BY id ORDER BY col1 DESC NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t` |
| `fa2fa751763c79a9` | postgres → snowflake | `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER ()` |
| `fc0def8bc0963182` | postgres → snowflake | `SELECT CORR(a, b) OVER (PARTITION BY c)` |
| `ff22173756c5ed60` | snowflake → duckdb | `SELECT FIRST_VALUE(is_deleted) OVER (PARTITION BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS nth_is_deleted FROM my_table` |
