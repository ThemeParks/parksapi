# ParksAPI — everything runs in a container (Node 24 / npm 11 inside).
# Nothing here needs Node installed on the host.
#
#   make            → this help
#   make build      → build the image once
#   make park PARK=efteling
#
# On a Podman host (Fedora and friends), override COMPOSE — rootless Podman
# maps your uid to a subuid unless it is told to keep it:
#   make COMPOSE="podman-compose --env-file /dev/null --podman-run-args=--userns=keep-id" dev

# --env-file /dev/null: compose otherwise reads the app's .env for its own
# interpolation, where a key named TZ, UID or GID would silently win over the
# values exported below.
COMPOSE ?= docker compose --env-file /dev/null
SERVICE  = parksapi
RUN      = $(COMPOSE) run --rm $(SERVICE)

# The container writes into the bind mount, so it runs as the host user.
export UID := $(shell id -u)
export GID := $(shell id -g)

# Compose otherwise derives the project from the directory basename, so two
# checkouts both named parksapi share one project: `make clean` in a review
# clone would tear down a `make dev` running in the main tree.
#
# macOS ships shasum rather than GNU coreutils, and an empty digest here would
# put every checkout back into one shared project. The failing command consumes
# no stdin, so the fallback still receives the whole input.
export COMPOSE_PROJECT_NAME := parksapi-$(shell printf '%s' '$(CURDIR)' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)

# Optional: extra flags forwarded to the test harness, e.g.
#   make dev ARGS="--skip-schedules --verbose"
ARGS ?=
PARK ?=

.DEFAULT_GOAL := help

##@ Setup

.PHONY: build
build: ## Build the dev image (deps install on first run, into node_modules/)
	$(COMPOSE) build

.PHONY: rebuild
rebuild: ## Rebuild the image from scratch, ignoring layer cache
	$(COMPOSE) build --no-cache

.PHONY: deps
deps: ## Force a dependency reinstall from the lockfile (does not build dist/ — see compile)
	$(COMPOSE) run --rm -e PARKSAPI_FORCE_DEPS=1 $(SERVICE) true

##@ Running the harness

.PHONY: dev
dev: ## Test all 80 destinations against live APIs (long; most need credentials)
	$(RUN) npm run dev -- $(ARGS)

.PHONY: park
park: ## Test one park — make park PARK=efteling
	@test -n "$(PARK)" || { echo "usage: make park PARK=<parkId>   (see: make list)"; exit 1; }
	$(RUN) npm run dev -- "$(PARK)" $(ARGS)

.PHONY: category
category: ## Test a whole category — make category CATEGORY="Alton Towers"
	@test -n "$(CATEGORY)" || { echo "usage: make category CATEGORY=<name>"; exit 1; }
	$(RUN) npm run dev -- --category "$(CATEGORY)" $(ARGS)

.PHONY: list
list: ## List available park IDs
	$(RUN) npm run dev -- --list

.PHONY: health
health: ## Health-check all endpoints (ARGS to scope it)
	$(RUN) npm run health -- $(ARGS)

##@ Build & tests

.PHONY: test
test: ## Run the Vitest suite (ARGS to scope it, e.g. ARGS=src/tags)
	$(RUN) npm test -- $(ARGS)

.PHONY: coverage
coverage: ## Run tests with coverage report
	$(RUN) npm run test:coverage

.PHONY: compile
compile: ## Type-check / compile TypeScript to dist/
	$(RUN) npm run build

.PHONY: shell
shell: ## Open a shell inside the container
	$(RUN) bash

##@ Housekeeping

.PHONY: cache-clear
cache-clear: ## Drop the SQLite cache and retest everything fresh
	$(RUN) npm run dev -- --clear-cache $(ARGS)

.PHONY: clean
clean: ## Remove this tree's containers, networks and volumes
	$(COMPOSE) down -v --remove-orphans

.PHONY: clean-all
clean-all: ## Also delete the built image (engine-agnostic, unlike a bare rmi)
	$(COMPOSE) down -v --remove-orphans --rmi local

##@ Help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nParksAPI — containerised commands\n"} \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\nFirst run:  make build && make park PARK=efteling\n\n"
