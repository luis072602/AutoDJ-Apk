package co.autodj.app;

import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

/** Conecta NewPipeExtractor con la red: le hace las peticiones HTTP usando OkHttp. */
final class OkDownloader extends Downloader {
    static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

    private final OkHttpClient client;

    OkDownloader(OkHttpClient client) {
        this.client = client;
    }

    @Override
    public Response execute(Request request) throws IOException, ReCaptchaException {
        final String method = request.httpMethod();
        final String url = request.url();
        final byte[] data = request.dataToSend();

        RequestBody body = null;
        if (data != null) {
            body = RequestBody.create(data);
        } else if ("POST".equals(method) || "PUT".equals(method)) {
            body = RequestBody.create(new byte[0]);
        }

        final okhttp3.Request.Builder builder = new okhttp3.Request.Builder()
                .method(method, body)
                .url(url)
                .addHeader("User-Agent", USER_AGENT);

        for (Map.Entry<String, List<String>> header : request.headers().entrySet()) {
            builder.removeHeader(header.getKey());
            for (String value : header.getValue()) {
                builder.addHeader(header.getKey(), value);
            }
        }

        try (okhttp3.Response response = client.newCall(builder.build()).execute()) {
            if (response.code() == 429) {
                throw new ReCaptchaException("reCaptcha Challenge requested", url);
            }
            final ResponseBody responseBody = response.body();
            final String text = responseBody == null ? null : responseBody.string();
            return new Response(response.code(), response.message(), response.headers().toMultimap(),
                    text, response.request().url().toString());
        }
    }
}
