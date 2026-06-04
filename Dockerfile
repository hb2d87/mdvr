FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nginx \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY requirements-dev.txt .
ARG INSTALL_DEV_DEPS=0
RUN if [ "$INSTALL_DEV_DEPS" = "1" ]; then pip install --no-cache-dir -r requirements-dev.txt; fi

# Copy application code
COPY . .
RUN chmod +x /app/docker-entrypoint.sh
RUN mkdir -p /vaults/demo && cp -a /app/welcome-vault/. /vaults/demo/

# Expose the nginx public port used by MDVR
EXPOSE 8080

# Start nginx + FastAPI via the bootstrap script
CMD ["/app/docker-entrypoint.sh"]
