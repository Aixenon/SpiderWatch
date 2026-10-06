param([string]$Version="0.7.0-dev", [string]$Target="all")
$ErrorActionPreference="Stop"
python (Join-Path $PSScriptRoot "build.py") --version $Version --target $Target
exit $LASTEXITCODE
