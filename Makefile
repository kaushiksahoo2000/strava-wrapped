.PHONY: run dry fmt

run:
	npx tsx generate.ts

dry:
	DRY_RUN=true npx tsx generate.ts

fmt:
	npx prettier --write .
