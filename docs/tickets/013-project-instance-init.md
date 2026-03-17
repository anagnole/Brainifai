# Project Instance Init

Implement `brainifai init` when run inside a project directory. Creates a child instance at <project>/.brainifai/ with its own Kuzu DB. Prompts the user for instance type (from templates), and optionally a description. Registers itself with the global instance.
