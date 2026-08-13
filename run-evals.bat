@echo off
REM ============================================================================
REM  run-evals.bat - every check and evaluation, one command, one output file.
REM
REM    cd C:\Users\ADMIN\Desktop\episteme
REM    run-evals.bat
REM
REM  Writes everything to eval-run.txt in this folder. Send that one file.
REM
REM  Runs from the repository root and changes directory itself, so it works
REM  from anywhere, including a double-click.
REM
REM  DEGRADES GRACEFULLY. Sections needing credentials are skipped with a
REM  printed reason rather than crashing the run, so the offline checks still
REM  produce results on a machine with no .env.local.
REM
REM  READ-ONLY with respect to your data. The retrieval eval queries Pinecone
REM  and writes nothing; the prompt eval forces its own local scratch database.
REM  Both consume model tokens - that is the cost of measuring the real thing.
REM
REM  Optional: set MASTRA_BASE_URL first to include the latency benchmark, e.g.
REM    set MASTRA_BASE_URL=https://episteme-chat-mu.vercel.app
REM ============================================================================

set ROOT=%~dp0
set OUT=%ROOT%eval-run.txt

REM Quieten the per-embedding SDK compatibility notice. It repeats on every
REM call and buries the actual results; it says nothing about correctness.
set AI_SDK_LOG_WARNINGS=false

echo Writing to %OUT%
echo.

REM --- fresh file -------------------------------------------------------------
echo EPISTEME EVALUATION RUN > "%OUT%"
echo Started: %DATE% %TIME% >> "%OUT%"
echo. >> "%OUT%"

call :section "PROVENANCE"
echo Any number below is only interpretable against this commit. >> "%OUT%"
echo. >> "%OUT%"
echo --- commit --- >> "%OUT%"
git -C "%ROOT%." rev-parse --short HEAD >> "%OUT%" 2>&1
git -C "%ROOT%." log -1 --pretty=format:"%%s" >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo. >> "%OUT%"
echo --- uncommitted changes (empty means the run matches the commit) --- >> "%OUT%"
git -C "%ROOT%." status --short >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo --- versions --- >> "%OUT%"
node --version >> "%OUT%" 2>&1
call pnpm --version >> "%OUT%" 2>&1

REM ============================ OFFLINE CHECKS ================================
REM No credentials, no network, no tokens. If these fail, stop and fix before
REM spending money on the live sections below.

call :section "CORE - TYPE CHECK"
cd /d "%ROOT%episteme-core"
call pnpm typecheck >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"

call :section "CORE - TEST SUITE"
call pnpm test >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"

call :section "CHAT - TEST SUITE"
cd /d "%ROOT%episteme-chat"
call pnpm test >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"

REM ============================ LIVE EVALUATIONS ==============================

call :section "RETRIEVAL, ENTITLEMENT AND CASCADE EVAL"
cd /d "%ROOT%episteme-core"
if not exist ".env.local" goto :no_env_retrieval
REM This runner does NOT load .env.local itself - only the prompt runner does -
REM so the credentials must come in through Node's --env-file or the KB tier
REM reports SKIPPED however complete the env file is.
node --env-file=.env.local --import tsx src/evals/run-retrieval-evals.ts >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"
goto :after_retrieval
:no_env_retrieval
echo SKIPPED - episteme-core\.env.local not found. >> "%OUT%"
echo The platform tier would still run, but the KB, entitlement and cascade >> "%OUT%"
echo sections need PINECONE_API_KEY, PINECONE_INDEX and MISTRAL_API_KEY. >> "%OUT%"
:after_retrieval

call :section "PROMPT BEHAVIOUR EVAL"
if not exist ".env.local" goto :no_env_prompts
REM Concurrency defaults to 1 and 429s retry, so cases are no longer lost to
REM rate limiting. Expect this to take several minutes. Exit code 1 here means
REM some cases failed their scorers, which is a RESULT, not a broken run.
call pnpm eval:prompts >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"
goto :after_prompts
:no_env_prompts
echo SKIPPED - episteme-core\.env.local not found. >> "%OUT%"
:after_prompts

call :section "LATENCY BENCHMARK"
cd /d "%ROOT%episteme-chat"
if not defined MASTRA_BASE_URL goto :no_base_url
if not exist ".env.local" goto :no_env_latency
REM Measure the DEPLOYMENT, not localhost: a local number describes your laptop's
REM network path and cannot be cited against NFR-101.
echo Target: %MASTRA_BASE_URL% >> "%OUT%"
node --env-file=.env.local --import tsx scripts/bench-latency.ts --runs 25 >> "%OUT%" 2>&1
echo exit code: %ERRORLEVEL% >> "%OUT%"
goto :after_latency
:no_env_latency
echo SKIPPED - episteme-chat\.env.local not found (needs MASTRA_ADMIN_KEY). >> "%OUT%"
goto :after_latency
:no_base_url
echo SKIPPED - MASTRA_BASE_URL is not set. >> "%OUT%"
echo To include this section, run before this script: >> "%OUT%"
echo   set MASTRA_BASE_URL=https://your-app.vercel.app >> "%OUT%"
echo Benchmarking localhost instead would measure your laptop's network path >> "%OUT%"
echo rather than the deployed system, which is not citable against NFR-101. >> "%OUT%"
:after_latency

REM ================================ DONE ======================================
call :section "RUN COMPLETE"
echo Finished: %DATE% %TIME% >> "%OUT%"

cd /d "%ROOT%."
echo.
echo Done. Results written to %OUT%
echo.
echo Copy it if you want to keep this run - the next execution overwrites it.
goto :eof

REM --- helpers ----------------------------------------------------------------
:section
echo. >> "%OUT%"
echo ============================================================================== >> "%OUT%"
echo %~1 >> "%OUT%"
echo ============================================================================== >> "%OUT%"
echo [%TIME%] %~1
goto :eof
