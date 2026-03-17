# Centralize Ingestion

Move all external source ingestion to the global instance. Child instances should never connect to Slack, GitHub, ClickUp, etc. directly. The global orchestrator is the single point of ingestion.
