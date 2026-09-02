"""Base model for data crossing the TS↔Python seam.

Wire JSON is camelCase (the repo's TS convention); Python code is
snake_case. The alias generator bridges the two without per-field alias
noise, and keeps constructor signatures snake_case for the type checker.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
