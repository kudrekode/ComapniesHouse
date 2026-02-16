$env:COMPANIES_HOUSE_API_KEY="e5f0e0fd-344a-483a-8ad1-efa2b405caf8"

$env:OUTPUT_CSV="companies.csv"   # optional
$env:CONCURRENCY="4"             # optional
$env:MAX_COMPANIES="0"           # optional; 0 = no limit (bring in all that match filters)
$env:MAX_COMPANIES_TO_CHECK="0"   # optional; 0 = no limit (all companies). Use e.g. 500 as safety cap per 5-min run.
npm start
