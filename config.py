"""
Configuration centralisée pour C'est Trop Dur - Pictionary.

Utilisation:
    from config import config
"""

import os


class Config:
    PORT = 5016
    HOST = "0.0.0.0"
    SECRET_KEY = os.environ.get('SECRET_KEY', None)
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    CORS_ALLOWED_ORIGINS = "*"
    RATE_LIMIT_DEFAULT = ["10000 per day", "200 per minute"]
    RATE_LIMIT_CREATE = "30 per minute"
    RATE_LIMIT_JOIN = "50 per minute"
    ROOM_CLEANUP_INTERVAL = 300
    ROOM_MAX_AGE_HOURS = 2
    MAX_PLAYERS = 6
    MIN_PLAYERS = 2
    ROUND_TIME_SECONDS = 80
    LOG_LEVEL = "INFO"
    LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class DevelopmentConfig(Config):
    DEBUG = True
    USE_RELOADER = True
    SECRET_KEY = Config.SECRET_KEY or os.urandom(24)
    RATE_LIMIT_DEFAULT = ["10000 per day", "200 per minute"]
    LOG_LEVEL = "DEBUG"


class ProductionConfig(Config):
    DEBUG = False
    USE_RELOADER = False

    @property
    def SECRET_KEY(self):
        key = os.environ.get('SECRET_KEY')
        if not key:
            raise ValueError("SECRET_KEY must be set in production!")
        return key

    RATE_LIMIT_DEFAULT = ["5000 per day", "100 per minute"]
    RATE_LIMIT_CREATE = "10 per minute"
    RATE_LIMIT_JOIN = "20 per minute"
    ROOM_CLEANUP_INTERVAL = 180
    LOG_LEVEL = "INFO"


class TestingConfig(Config):
    DEBUG = True
    TESTING = True
    SECRET_KEY = "test-secret-key-not-for-production"
    RATE_LIMIT_DEFAULT = ["99999 per day", "9999 per minute"]
    ROOM_CLEANUP_INTERVAL = 1
    ROOM_MAX_AGE_HOURS = 0.001


_env = os.environ.get('FLASK_ENV', 'development')
_configs = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig
}
config = _configs.get(_env, DevelopmentConfig)()
__all__ = ['config', 'Config', 'DevelopmentConfig', 'ProductionConfig', 'TestingConfig']
