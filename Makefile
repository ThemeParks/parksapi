# ParksAPI — everything runs in a container (Node 24 / npm 11 inside).
# Nothing here needs Node installed on the host.
#
#   make            → this help
#   make build      → build the image once
#   make park PARK=efteling
#
# On a Podman host (Fedora and friends), override COMPOSE:
#   make COMPOSE="podman-compose --env-file /dev/null" dev

# --env-file /dev/null: compose otherwise parses the app's .env for its own
# interpolation and rejects multi-line values.
COMPOSE ?= docker compose --env-file /dev/null
SERVICE  = parksapi
RUN      = $(COMPOSE) run --rm $(SERVICE)

# The container writes into the bind mount, so it runs as the host user.
export UID := $(shell id -u)
export GID := $(shell id -g)

# Optional: extra flags forwarded to the test harness, e.g.
#   make dev ARGS="--skip-schedules --verbose"
ARGS ?=
PARK ?=

.DEFAULT_GOAL := help

##@ Setup

.PHONY: build
build: ## Build the dev image (npm install happens here)
	$(COMPOSE) build

.PHONY: rebuild
rebuild: ## Rebuild the image from scratch, ignoring layer cache
	$(COMPOSE) build --no-cache

.PHONY: deps
deps: ## Reinstall node_modules inside the container volume
	$(RUN) npm ci --ignore-scripts

##@ Running the harness

.PHONY: dev
dev: ## Test every park (long: 76 destinations, hits live APIs)
	$(RUN) npm run dev -- $(ARGS)

.PHONY: park
park: ## Test one park — make park PARK=efteling
	@test -n "$(PARK)" || { echo "usage: make park PARK=<parkId>   (see: make list)"; exit 1; }
	$(RUN) npm run dev -- $(PARK) $(ARGS)

.PHONY: category
category: ## Test a whole category — make category CATEGORY=Universal
	@test -n "$(CATEGORY)" || { echo "usage: make category CATEGORY=<name>"; exit 1; }
	$(RUN) npm run dev -- --category $(CATEGORY) $(ARGS)

.PHONY: list
list: ## List available park IDs
	$(RUN) npm run dev -- --list

.PHONY: health
health: ## Health-check all endpoints
	$(RUN) npm run health

##@ Build & tests

.PHONY: test
test: ## Run the Vitest suite
	$(RUN) npm test

.PHONY: coverage
coverage: ## Run tests with coverage report
	$(RUN) npm run test:coverage

.PHONY: compile
compile: ## Type-check / compile TypeScript to dist/
	$(RUN) npm run build

.PHONY: web
web: ## Serve the web admin on http://localhost:8888 (WEB_PORT to change)
	$(COMPOSE) --profile web run --rm --service-ports web

.PHONY: shell
shell: ## Open a shell inside the container
	$(RUN) bash

##@ Housekeeping

.PHONY: cache-clear
cache-clear: ## Drop the SQLite cache and retest everything fresh
	$(RUN) npm run dev -- --clear-cache $(ARGS)

.PHONY: clean
clean: ## Remove containers and the node_modules volume
	-$(COMPOSE) down -v

.PHONY: clean-all
clean-all: ## Also delete the built image (engine-agnostic, unlike a bare rmi)
	-$(COMPOSE) down -v --rmi all

##@ Help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nParksAPI — containerised commands\n"} \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\nFirst run:  make build && make park PARK=efteling\n\n"
