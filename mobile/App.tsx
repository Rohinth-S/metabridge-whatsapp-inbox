import React, {useEffect, useState} from "react";
import {SafeAreaView, FlatList, Text, View, ActivityIndicator} from "react-native";
import { listMessages } from "./api";

export default function App() {
  const [rows,setRows]=useState<Array<Record<string,unknown>>>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string>();
  useEffect(() => {
    listMessages({baseUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4030"})
      .then(setRows).catch((e:Error)=>setError(e.message)).finally(()=>setLoading(false));
  }, []);
  return <SafeAreaView style={{flex:1,padding:24}}>
    <Text style={{fontSize:28,fontWeight:"700",marginBottom:8}}>MetaBridge</Text>
    <Text style={{color:"#4b5563",marginBottom:16}}>Operational message view</Text>
    {loading ? <ActivityIndicator/> : error ? <Text>{error}</Text> : <FlatList data={rows} keyExtractor={(_,i)=>String(i)} renderItem={({item})=><View style={{padding:14,borderBottomWidth:1,borderColor:"#e5e7eb"}}><Text style={{fontWeight:"600"}}>{String(item.title ?? item.body ?? item.id)}</Text><Text style={{color:"#6b7280"}}>{String(item.status ?? "pending")}</Text></View>} />}
  </SafeAreaView>;
}
