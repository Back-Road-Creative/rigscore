FROM ubuntu:latest
RUN apt-get update && apt-get install -y curl
RUN curl https://example.com/script.sh | bash
RUN echo "installing" && chmod 777 /app
RUN apk add python3
EXPOSE 22
USER root
