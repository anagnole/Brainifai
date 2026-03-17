# Batch Processing

The orchestrator should process ingested data in batches rather than one item at a time. After an ingestion run, batch all new data and make routing decisions in bulk to reduce LLM API calls and improve efficiency.
