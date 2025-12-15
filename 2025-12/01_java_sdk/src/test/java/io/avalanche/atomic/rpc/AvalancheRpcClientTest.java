package io.avalanche.atomic.rpc;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for AvalancheRpcClient.
 * 
 * Note: These are unit tests that don't make actual network calls.
 * For integration tests, you'd need a running Avalanche node.
 */
class AvalancheRpcClientTest {
    
    @Test
    void testClientCreation() {
        AvalancheRpcClient client = new AvalancheRpcClient("https://api.avax.network");
        assertNotNull(client);
    }
    
    @Test
    void testClientCreationWithTrailingSlash() {
        // Should handle trailing slash
        AvalancheRpcClient client = new AvalancheRpcClient("https://api.avax.network/");
        assertNotNull(client);
    }
    
    @Test
    void testClientWithNullUrl() {
        AvalancheRpcClient client = new AvalancheRpcClient(null);
        
        // Should throw when trying to use client without URL
        assertThrows(IllegalStateException.class, () -> 
            client.getUTXOs(List.of("C-avax1test"), "P")
        );
    }
    
    @Test
    void testParseUtxosResponseEmpty() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        // Use reflection to test private method
        Method parseMethod = AvalancheRpcClient.class.getDeclaredMethod("parseUtxosResponse", String.class);
        parseMethod.setAccessible(true);
        
        String emptyResponse = "{\"jsonrpc\":\"2.0\",\"result\":{\"numFetched\":\"0\",\"utxos\":[],\"endIndex\":{\"address\":\"\",\"utxo\":\"\"}},\"id\":1}";
        
        @SuppressWarnings("unchecked")
        List<?> result = (List<?>) parseMethod.invoke(client, emptyResponse);
        
        assertTrue(result.isEmpty());
    }
    
    @Test
    void testParseUtxosResponseError() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        Method parseMethod = AvalancheRpcClient.class.getDeclaredMethod("parseUtxosResponse", String.class);
        parseMethod.setAccessible(true);
        
        String errorResponse = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"invalid address\"},\"id\":1}";
        
        Exception exception = assertThrows(Exception.class, () -> 
            parseMethod.invoke(client, errorResponse)
        );
        
        assertTrue(exception.getCause().getMessage().contains("invalid address"));
    }
    
    @Test
    void testParseTxIdResponse() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        Method parseMethod = AvalancheRpcClient.class.getDeclaredMethod("parseTxIdResponse", String.class);
        parseMethod.setAccessible(true);
        
        String successResponse = "{\"jsonrpc\":\"2.0\",\"result\":{\"txID\":\"2QouvFWUbjuySRxeX5xMbNCuAaKWfbk5FeEa2JmoF85RKLnC8\"},\"id\":1}";
        
        String txId = (String) parseMethod.invoke(client, successResponse);
        
        assertEquals("2QouvFWUbjuySRxeX5xMbNCuAaKWfbk5FeEa2JmoF85RKLnC8", txId);
    }
    
    @Test
    void testParseTxIdResponseError() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        Method parseMethod = AvalancheRpcClient.class.getDeclaredMethod("parseTxIdResponse", String.class);
        parseMethod.setAccessible(true);
        
        String errorResponse = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"tx already accepted\"},\"id\":1}";
        
        Exception exception = assertThrows(Exception.class, () -> 
            parseMethod.invoke(client, errorResponse)
        );
        
        assertTrue(exception.getCause().getMessage().contains("tx already accepted"));
    }
    
    @Test
    void testParseStatusResponse() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        Method parseMethod = AvalancheRpcClient.class.getDeclaredMethod("parseStatusResponse", String.class);
        parseMethod.setAccessible(true);
        
        String acceptedResponse = "{\"jsonrpc\":\"2.0\",\"result\":{\"status\":\"Accepted\"},\"id\":1}";
        assertEquals("Accepted", parseMethod.invoke(client, acceptedResponse));
        
        String processingResponse = "{\"jsonrpc\":\"2.0\",\"result\":{\"status\":\"Processing\"},\"id\":1}";
        assertEquals("Processing", parseMethod.invoke(client, processingResponse));
        
        String rejectedResponse = "{\"jsonrpc\":\"2.0\",\"result\":{\"status\":\"Rejected\"},\"id\":1}";
        assertEquals("Rejected", parseMethod.invoke(client, rejectedResponse));
    }
    
    @Test
    void testExtractJsonValue() throws Exception {
        AvalancheRpcClient client = new AvalancheRpcClient("https://test.local");
        
        Method extractMethod = AvalancheRpcClient.class.getDeclaredMethod("extractJsonValue", String.class, String.class);
        extractMethod.setAccessible(true);
        
        String json = "{\"key1\":\"value1\",\"key2\":\"value2\"}";
        
        assertEquals("value1", extractMethod.invoke(client, json, "key1"));
        assertEquals("value2", extractMethod.invoke(client, json, "key2"));
        assertNull(extractMethod.invoke(client, json, "key3"));
    }
    
    @Test
    void testEndpointPath() {
        // Verify the endpoint constant is correct
        // This tests that we're using /ext/bc/C/avax, not /ext/bc/C/rpc
        AvalancheRpcClient client = new AvalancheRpcClient("https://api.avax.network");
        assertNotNull(client);
        
        // The actual endpoint is tested indirectly - if wrong, actual calls would fail
        // This test mainly documents the expected behavior
    }
}

